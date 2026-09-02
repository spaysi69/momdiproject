import Redis from 'ioredis';
import { ServiceConfig, RouteConfig } from '../config/schema';
import { RateLimiter, QuotaExceededError } from '../core/rateLimiter';
import { RouteStateMachine } from '../core/stateMachine';
import { EnrichmentResponse } from '../core/types';
import { classifyProviderError } from './errors';
import { ContactSearchResult, SeamlessClient } from './client';
import { normalizeLinkedInUrl, cacheKey } from '../utils/normalizeUrl';
import { EnrichmentCache } from '../cache/enrichmentCache';
import { logger } from '../utils/logger';
import { SupabaseStore } from '../storage/supabase';
import { CreditLedger, ProviderCreditsExhaustedError } from '../core/creditLedger';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeCompanyName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface CompanyRecord {
  name: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  current?: boolean;
  domain?: string;
  linkedinUrl?: string;
}

function extractCareerCompanies(raw: Record<string, unknown>, profile: EnrichmentResponse): CompanyRecord[] {
  const found = new Map<string, CompanyRecord>();
  const candidateArrays: unknown[] = [];

  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(child) && /(employment|experience|career|work.?history|job.?history|positions?|jobs?)/i.test(key)) {
        candidateArrays.push(child);
      }
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };

  visit(raw);

  for (const arr of candidateArrays) {
    for (const item of arr as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const companyObj = [obj.company, obj.employer, obj.organization, obj.companyInfo]
        .find(value => value && typeof value === 'object') as Record<string, unknown> | undefined;
      const name =
        text(obj.companyName) ?? text(obj.company) ?? text(obj.employerName) ?? text(obj.employer) ??
        text(obj.organizationName) ?? text(companyObj?.name) ?? text(companyObj?.companyName);
      if (!name) continue;
      const key = normalizeCompanyName(name);
      if (!key || key === 'unemployed' || key === 'student') continue;

      const entry: CompanyRecord = {
        name,
        title: text(obj.title) ?? text(obj.jobTitle) ?? text(obj.position) ?? text(obj.role),
        startDate: text(obj.startDate) ?? text(obj.start) ?? text(obj.from),
        endDate: text(obj.endDate) ?? text(obj.end) ?? text(obj.to),
        current: Boolean(obj.current ?? obj.isCurrent ?? obj.currentRole) || (!text(obj.endDate) && !text(obj.end)),
        domain: text(obj.domain) ?? text(companyObj?.domain),
        linkedinUrl: text(obj.companyLinkedInUrl) ?? text(obj.companyLIProfileUrl) ?? text(obj.linkedinUrl) ?? text(companyObj?.linkedinUrl),
      };

      const existing = found.get(key);
      found.set(key, existing ? {
        ...existing,
        title: existing.title ?? entry.title,
        startDate: existing.startDate ?? entry.startDate,
        endDate: existing.endDate ?? entry.endDate,
        current: Boolean(existing.current || entry.current),
        domain: existing.domain ?? entry.domain,
        linkedinUrl: existing.linkedinUrl ?? entry.linkedinUrl,
      } : entry);
    }
  }

  if (profile.company) {
    const key = normalizeCompanyName(profile.company);
    const existing = found.get(key);
    found.set(key, {
      name: existing?.name ?? profile.company,
      title: existing?.title ?? profile.title,
      current: true,
      domain: existing?.domain ?? profile.companyDomain,
      linkedinUrl: existing?.linkedinUrl ?? profile.companyLinkedInUrl,
    });
  }

  return [...found.values()].sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)));
}

type RouteRuntime = { cfg: RouteConfig; client: SeamlessClient; machine: RouteStateMachine };

function routeUsableForSearch(route: RouteRuntime): boolean {
  const state = route.machine.snapshot();
  if (['AUTH_FAILED', 'DISABLED'].includes(state.status)) return false;
  if (state.status === 'COOLDOWN' && state.cooldownUntil && state.cooldownUntil > Date.now()) return false;
  if (state.status === 'COOLDOWN' && state.cooldownUntil && state.cooldownUntil <= Date.now()) route.machine.onCooldownExpired();
  return true;
}

export class EnrichmentService {
  private readonly limiter: RateLimiter;
  private readonly cache: EnrichmentCache;
  private readonly store: SupabaseStore;
  private readonly redis: Redis;
  private readonly credits: CreditLedger;
  private readonly routes: RouteRuntime[];

  constructor(private readonly config: ServiceConfig, redis: Redis) {
    this.redis = redis;
    this.credits = new CreditLedger(redis);
    this.limiter = new RateLimiter(redis);
    this.cache = new EnrichmentCache(redis, config.cacheTtlSeconds);
    this.store = new SupabaseStore();

    const routeConfigs = config.routes ?? [{
      id: 'primary',
      apiKeyEnv: config.apiKeyEnv,
      credits: config.credits.starting,
      limits: config.limits,
      priority: 100,
      egressGroup: 'egress-1',
    }];

    this.routes = routeConfigs.map((cfg: RouteConfig) => {
      const apiKey = process.env[cfg.apiKeyEnv]?.trim();
      if (!apiKey) throw new Error(`Missing required secret ${cfg.apiKeyEnv}`);
      const proxyUrl = cfg.proxyUrlEnv ? process.env[cfg.proxyUrlEnv]?.trim() : undefined;
      const client = new SeamlessClient({
        baseUrl: config.providerBaseUrl,
        apiKey,
        timeoutMs: config.requestTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        maxPolls: config.maxPolls,
        proxyUrl,
      });
      const machine = new RouteStateMachine(cfg.id, cfg.limits.rpm, cfg.limits.rpd);
      void this.credits.ensureInitialized(cfg.id, this.startingCredits(cfg));
      return { cfg, client, machine };
    }).sort((a: RouteRuntime, b: RouteRuntime) => b.cfg.priority - a.cfg.priority);
  }

  private startingCredits(route: RouteRuntime['cfg']): number {
    const env = process.env[`SEAMLESS_API_CREDITS_${route.id.toUpperCase()}`]?.trim();
    if (env && /^\d+$/.test(env)) return Number(env);
    return route.credits;
  }

  private candidateRoutes(): RouteRuntime[] {
    return this.routes.slice().sort((a, b) => {
      const sa = a.machine.snapshot();
      const sb = b.machine.snapshot();
      const rank = (status: ReturnType<RouteStateMachine['snapshot']>) => {
        if (status.status === 'READY') return 0;
        if (status.status === 'DEGRADED') return 1;
        return 2;
      };
      return rank(sa) - rank(sb) || b.cfg.priority - a.cfg.priority;
    });
  }

  private async usableRoutes(): Promise<RouteRuntime[]> {
    const out: RouteRuntime[] = [];
    for (const route of this.candidateRoutes()) {
      const state = route.machine.snapshot();
      if (['AUTH_FAILED', 'CREDITS_EXHAUSTED', 'DISABLED'].includes(state.status)) continue;
      if (state.status === 'COOLDOWN' && state.cooldownUntil && state.cooldownUntil > Date.now()) continue;
      if (state.status === 'COOLDOWN' && state.cooldownUntil && state.cooldownUntil <= Date.now()) route.machine.onCooldownExpired();
      const credits = await this.credits.remaining(route.cfg.id, this.startingCredits(route.cfg));
      if (credits < 1) continue;
      try {
        const usage = await this.limiter.usage(route.cfg.id);
        if (usage.rpm >= route.cfg.limits.rpm || usage.rpd >= route.cfg.limits.rpd) continue;
        out.push(route);
      } catch (error) {
        if (error instanceof QuotaExceededError) continue;
        throw error;
      }
    }
    return out;
  }

  private async acquireLock(key: string, token: string, ttlSeconds = 120): Promise<boolean> {
    return (await this.redis.set(`enrich:lock:${key}`, token, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    try {
      const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
      await this.redis.eval(script, 1, `enrich:lock:${key}`, token);
    } catch (error: any) {
      logger.warn('enrichment.lock_release_failed', { message: error?.message || 'unknown' });
    }
  }

  private async reserveRoute(route: RouteRuntime): Promise<{ rpm: number; rpd: number }> {
    const usage = await this.limiter.reserve(route.cfg.id, route.cfg.limits.rpm, route.cfg.limits.rpd);
    const remaining = await this.credits.remaining(route.cfg.id, this.startingCredits(route.cfg));
    if (remaining < 1) throw new ProviderCreditsExhaustedError();
    return usage;
  }

  /**
   * Free person preview. This method ONLY calls /search/contacts.
   * It must never reserve quota or decrement the research-credit ledger.
   */
  async inspectPersonCompanies(linkedinUrl: string) {
    const normalized = normalizeLinkedInUrl(linkedinUrl);
    if (!/^https?:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9-_%]+\/?$/i.test(normalized)) {
      throw new Error('Enter a valid LinkedIn person URL, for example https://www.linkedin.com/in/example/');
    }

    // FREE LOOKUP PATH: deliberately independent of Redis/Supabase.
    // This guarantees that a cache/database connection problem can never leave
    // the Find person button spinning before Seamless Search is even attempted.
    const routes = this.routes.filter(routeUsableForSearch).sort((a, b) => b.cfg.priority - a.cfg.priority);
    if (!routes.length) throw new Error('No provider route is currently available for contact search. No research credit was consumed.');

    let lastError: unknown = null;
    for (const route of routes) {
      try {
        const result = await route.client.searchPersonByLinkedInUrl(normalized, 50);
        const contact = result.contact as Record<string, unknown>;
        const preview: EnrichmentResponse = {
          fullName: text(contact.fullName) ?? text(contact.name),
          firstName: text(contact.firstName),
          lastName: text(contact.lastName),
          title: text(contact.title) ?? text(contact.jobTitle),
          company: text(contact.company) ?? text(contact.companyName),
          linkedinUrl: text(contact.lIProfileUrl) ?? text(contact.liProfileUrl) ?? text(contact.linkedinUrl) ?? normalized,
          companyDomain: text(contact.website) ?? text(contact.companyDomain),
          companyLinkedInUrl: text(contact.companyLIProfileUrl) ?? text(contact.companyLinkedInUrl),
          department: text(contact.department),
          seniority: text(contact.seniority),
          raw: contact,
        };
        return {
          status: 'done' as const,
          person: { name: preview.fullName ?? 'LinkedIn profile', linkedinUrl: preview.linkedinUrl, currentCompany: preview.company },
          companies: extractCareerCompanies(contact, preview),
          cached: false,
        };
      } catch (error) {
        lastError = error;
        const classified = classifyProviderError(error);
        logger.warn('person_search.route_failure', {
          routeId: route.cfg.id,
          kind: classified.kind,
          status: classified.status,
          message: classified.message,
        });
        if (classified.kind === 'AUTH') route.machine.onAuthFailure(classified.status ?? 401);
        else if (classified.kind === 'RATE_LIMIT') route.machine.on429(classified.retryAfterSeconds ?? 60);
        else if (classified.kind === 'TRANSIENT') route.machine.onTransientFailure(classified.status ?? null);
        if (!['AUTH', 'RATE_LIMIT', 'TRANSIENT'].includes(classified.kind)) throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Person search failed. No research credit was consumed.');
  }

  // Kept for compatibility with older callers; free search intentionally does not use it.
  private previewFromProfile(profile: EnrichmentResponse, normalized: string, cached: boolean) {
    return {
      status: 'done' as const,
      person: { name: profile.fullName ?? 'LinkedIn profile', linkedinUrl: profile.linkedinUrl || normalized, currentCompany: profile.company },
      companies: extractCareerCompanies(profile.raw ?? {}, profile),
      cached,
    };
  }

  /** Paid operation: this is the only person-first path allowed to call contact research. */
  async enrichPersonForCompany(input: { linkedinUrl: string; personName: string; companyName: string; title?: string }) {
    const linkedinUrl = normalizeLinkedInUrl(input.linkedinUrl);
    if (!input.personName.trim() || !input.companyName.trim()) {
      throw new Error('Person name and selected company are required for enrichment.');
    }

    const identity = `person-company:${cacheKey(linkedinUrl)}:${normalizeCompanyName(input.companyName)}`;

    // Exact person + company lookup first. This prevents spending a research credit
    // when the same company-specific enrichment is already persisted.
    const persisted = await this.store.get(identity);
    if (persisted) {
      await this.cache.set(identity, persisted);
      return { data: persisted, cached: true, source: 'supabase' as const, attempts: 0, creditsRemaining: await this.totalCredits() };
    }

    const cached = await this.cache.get(identity);
    if (cached) {
      return { data: cached, cached: true, source: 'redis' as const, attempts: 0, creditsRemaining: await this.totalCredits() };
    }

    const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (!(await this.acquireLock(identity, lockToken))) {
      throw new Error('This person and company are already being enriched. Please wait for that request to finish and then refresh the result.');
    }

    try {
      // Re-check after acquiring the lock in case another request completed just before it.
      const second = await this.store.get(identity);
      if (second) {
        await this.cache.set(identity, second);
        return { data: second, cached: true, source: 'supabase' as const, attempts: 0, creditsRemaining: await this.totalCredits() };
      }

      const routes = await this.usableRoutes();
      let lastError: unknown = null;

      for (const route of routes) {
        for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
          try {
            await this.reserveRoute(route);
            const started = Date.now();
            const data = await route.client.researchContactByIdentity(
              { contactName: input.personName, companyName: input.companyName, title: input.title, linkedinUrl },
              async () => { await this.credits.consume(route.cfg.id, 1); },
            );

            const creditsRemaining = await this.totalCredits();
            await this.store.upsert(identity, data);
            await this.cache.set(identity, data);
            await this.saveByLinkedInIfPresent(data);

            const usage = await this.limiter.usage(route.cfg.id);
            route.machine.onSuccess(Date.now() - started, usage.rpm, usage.rpd);
            logger.info('enrichment.person_company.success', {
              routeId: route.cfg.id,
              attempt,
              egressGroup: route.cfg.egressGroup,
              durationMs: Date.now() - started,
              creditsRemaining,
              companyName: input.companyName,
              linkedinUrl,
            });
            return { data, cached: false, source: 'provider' as const, attempts: attempt, creditsRemaining };
          } catch (error) {
            lastError = error;
            const classified = classifyProviderError(error);
            if (classified.kind === 'AUTH') route.machine.onAuthFailure(classified.status ?? 401);
            else if (classified.kind === 'CREDITS') route.machine.onCreditsExhausted(classified.status ?? 422);
            else if (classified.kind === 'RATE_LIMIT') route.machine.on429(classified.retryAfterSeconds ?? 60);
            else if (classified.kind === 'TRANSIENT') route.machine.onTransientFailure(classified.status ?? null);

            if (error instanceof ProviderCreditsExhaustedError || classified.kind === 'AUTH' || classified.kind === 'CREDITS') break;
            if (classified.kind !== 'TRANSIENT' && classified.kind !== 'RATE_LIMIT') throw error;
            if (attempt >= this.config.maxAttempts) break;
            await new Promise(resolve => setTimeout(resolve, Math.min(5000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 200)));
          }
        }
      }

      throw lastError ?? new Error('No configured provider route has available credit and quota capacity.');
    } finally {
      await this.releaseLock(identity, lockToken);
    }
  }

  private async saveByLinkedInIfPresent(data: EnrichmentResponse) {
    if (!data.linkedinUrl) return;
    const key = cacheKey(data.linkedinUrl);
    await this.store.upsert(data.linkedinUrl, data);
    await this.cache.set(key, data);
  }

  private async totalCredits(): Promise<number> {
    let total = 0;
    for (const route of this.routes) total += await this.credits.remaining(route.cfg.id, this.startingCredits(route.cfg));
    return total;
  }

  async status() {
    const routes = [];
    for (const route of this.routes) {
      const state = route.machine.snapshot();
      const usage = await this.limiter.usage(route.cfg.id);
      const creditsRemaining = await this.credits.remaining(route.cfg.id, this.startingCredits(route.cfg));
      routes.push({
        id: route.cfg.id,
        status: state.status,
        rpmLimit: route.cfg.limits.rpm,
        rpmRemaining: Math.max(0, route.cfg.limits.rpm - usage.rpm),
        rpdLimit: route.cfg.limits.rpd,
        rpdRemaining: Math.max(0, route.cfg.limits.rpd - usage.rpd),
        creditsRemaining,
        creditsLimit: this.startingCredits(route.cfg),
        egressGroup: route.cfg.egressGroup,
      });
    }
    const creditsRemaining = routes.reduce((sum, route) => sum + route.creditsRemaining, 0);
    const creditsLimit = routes.reduce((sum, route) => sum + route.creditsLimit, 0);
    return {
      routes,
      creditsRemaining,
      creditsLimit,
      route: routes[0],
      usage: {
        rpm: routes[0] ? routes[0].rpmLimit - routes[0].rpmRemaining : 0,
        rpd: routes[0] ? routes[0].rpdLimit - routes[0].rpdRemaining : 0,
      },
    };
  }

  async ready() {
    await this.redis.ping();
    await this.store.ping();
  }
}
