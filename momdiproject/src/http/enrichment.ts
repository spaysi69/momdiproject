import Redis from 'ioredis';
import { ServiceConfig } from '../config/schema';
import { RateLimiter, QuotaExceededError } from '../core/rateLimiter';
import { RouteStateMachine } from '../core/stateMachine';
import { EnrichmentResponse } from '../core/types';
import { classifyProviderError } from './errors';
import { CompanySearchResult, SeamlessClient } from './client';
import { normalizeLinkedInUrl } from '../utils/normalizeUrl';
import { EnrichmentCache } from '../cache/enrichmentCache';
import { cacheKey } from '../utils/normalizeUrl';
import { logger } from '../utils/logger';
import { SupabaseStore } from '../storage/supabase';
import { CreditLedger, ProviderCreditsExhaustedError } from '../core/creditLedger';

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;


function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeCompanyName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractCareerCompanies(raw: Record<string, unknown>, profile: EnrichmentResponse) {
  const found = new Map<string, {
    name: string; title?: string; startDate?: string; endDate?: string; current?: boolean; domain?: string; linkedinUrl?: string;
  }>();

  const candidateArrays: unknown[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      if (Array.isArray(child) && /(employment|experience|career|work.?history|job.?history|positions?|jobs?)/i.test(lower)) {
        candidateArrays.push(child);
      }
      if (typeof child === 'object') visit(child, depth + 1);
    }
  };
  visit(raw);

  for (const arr of candidateArrays) {
    for (const item of arr as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const companyObj = [obj.company, obj.employer, obj.organization, obj.companyInfo].find(v => v && typeof v === 'object') as Record<string, unknown> | undefined;
      const name = text(obj.companyName) ?? text(obj.company) ?? text(obj.employerName) ?? text(obj.employer) ?? text(obj.organizationName) ?? text(companyObj?.name) ?? text(companyObj?.companyName);
      if (!name) continue;
      const key = normalizeCompanyName(name);
      if (!key || key === 'unemployed' || key === 'student') continue;
      const existing = found.get(key);
      const entry = {
        name,
        title: text(obj.title) ?? text(obj.jobTitle) ?? text(obj.position) ?? text(obj.role),
        startDate: text(obj.startDate) ?? text(obj.start) ?? text(obj.from),
        endDate: text(obj.endDate) ?? text(obj.end) ?? text(obj.to),
        current: Boolean(obj.current ?? obj.isCurrent ?? obj.currentRole) || !text(obj.endDate) && !text(obj.end),
        domain: text(obj.domain) ?? text(companyObj?.domain),
        linkedinUrl: text(obj.companyLinkedInUrl) ?? text(obj.companyLIProfileUrl) ?? text(obj.linkedinUrl) ?? text(companyObj?.linkedinUrl),
      };
      if (!existing) found.set(key, entry);
      else found.set(key, {
        ...existing,
        title: existing.title ?? entry.title,
        startDate: existing.startDate ?? entry.startDate,
        endDate: existing.endDate ?? entry.endDate,
        current: existing.current || entry.current,
        domain: existing.domain ?? entry.domain,
        linkedinUrl: existing.linkedinUrl ?? entry.linkedinUrl,
      });
    }
  }

  if (profile.company) {
    const key = normalizeCompanyName(profile.company);
    const existing = found.get(key);
    found.set(key, {
      name: existing?.name ?? profile.company,
      title: existing?.title ?? profile.title,
      startDate: existing?.startDate,
      endDate: existing?.endDate,
      current: true,
      domain: existing?.domain ?? profile.companyDomain,
      linkedinUrl: existing?.linkedinUrl ?? profile.companyLinkedInUrl,
    });
  }

  return [...found.values()].sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)));
}

export class EnrichmentService {
  private readonly limiter: RateLimiter;
  private readonly cache: EnrichmentCache;
  private readonly machine: RouteStateMachine;
  private readonly client: SeamlessClient;
  private readonly store: SupabaseStore;
  private readonly routeId = 'primary';
  private readonly redis: Redis;
  private readonly credits: CreditLedger;

  constructor(private readonly config: ServiceConfig, redis: Redis) {
    const apiKey = process.env[config.apiKeyEnv]?.trim();
    if (!apiKey) throw new Error(`Missing required secret ${config.apiKeyEnv}`);
    this.redis = redis;
    this.credits = new CreditLedger(redis);
    this.limiter = new RateLimiter(redis);
    this.cache = new EnrichmentCache(redis, config.cacheTtlSeconds);
    this.machine = new RouteStateMachine(this.routeId, config.limits.rpm, config.limits.rpd);
    this.client = new SeamlessClient({
      baseUrl: config.providerBaseUrl,
      apiKey,
      timeoutMs: config.requestTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      maxPolls: config.maxPolls,
    });
    this.store = new SupabaseStore();
    void this.credits.ensureInitialized(this.routeId, this.config.credits.starting);
  }

  private async acquireLock(key: string, token: string, ttlSeconds = 90): Promise<boolean> {
    return (await this.redis.set(`enrich:lock:${key}`, token, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, `enrich:lock:${key}`, token);
  }

  private async waitForExistingEnrichment(key: string, normalizedUrl: string): Promise<EnrichmentResponse | null> {
    for (let i = 0; i < 120; i += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 500));
      const persisted = await this.store.get(normalizedUrl);
      if (persisted) return persisted;
      const redisCached = await this.cache.get(key);
      if (redisCached) return redisCached;
      if (!(await this.redis.exists(`enrich:lock:${key}`))) return null;
    }
    return null;
  }

  async inspectPersonCompanies(linkedinUrl: string): Promise<{
    person: { name?: string; linkedinUrl: string; currentCompany?: string };
    companies: Array<{
      name: string;
      title?: string;
      startDate?: string;
      endDate?: string;
      current?: boolean;
      domain?: string;
      linkedinUrl?: string;
    }>;
    cached: boolean;
  }> {
    const normalized = normalizeLinkedInUrl(linkedinUrl);
    if (!/^https?:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9-_%]+\/?$/i.test(normalized)) {
      throw new Error('Enter a valid LinkedIn person URL, for example https://www.linkedin.com/in/example/');
    }

    // Reuse the existing profile enrichment/cache path. This means a repeated
    // profile lookup is served from storage rather than spending another
    // provider research credit.
    const enriched = await this.enrich(normalized);
    const raw = enriched.data.raw ?? {};
    const companies = extractCareerCompanies(raw, enriched.data);
    if (companies.length === 0 && enriched.data.company) {
      companies.push({
        name: enriched.data.company,
        title: enriched.data.title,
        current: true,
        domain: enriched.data.companyDomain,
        linkedinUrl: enriched.data.companyLinkedInUrl,
      });
    }

    return {
      person: {
        name: enriched.data.fullName,
        linkedinUrl: enriched.data.linkedinUrl || normalized,
        currentCompany: enriched.data.company,
      },
      companies,
      cached: enriched.cached,
    };
  }


  async enrichPersonForCompany(input: { linkedinUrl: string; personName: string; companyName: string; title?: string }): Promise<{ data: EnrichmentResponse; cached: boolean; source: 'provider'; attempts: number; creditsRemaining: number }> {
    const linkedinUrl = normalizeLinkedInUrl(input.linkedinUrl);
    const companyKey = normalizeCompanyName(input.companyName);
    const cacheIdentity = `person-company:v2:${cacheKey(linkedinUrl)}:${companyKey}`;

    // Check fast cache first, then persistent DB, before any provider request.
    const cached = await this.cache.get(cacheIdentity);
    if (cached) {
      const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
      return { data: cached, cached: true, source: 'provider', attempts: 0, creditsRemaining };
    }

    const persisted = await this.store.getPersonCompany(linkedinUrl, companyKey);
    if (persisted) {
      await this.cache.set(cacheIdentity, persisted);
      const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
      return { data: persisted, cached: true, source: 'provider', attempts: 0, creditsRemaining };
    }

    // Backward-compatible lookup for records saved by older versions that used
    // the person URL as the only DB key. Only reuse it when the company matches.
    const legacy = await this.store.get(linkedinUrl);
    if (legacy && normalizeCompanyName(legacy.company ?? '') === companyKey) {
      await this.store.upsertPersonCompany(linkedinUrl, companyKey, legacy);
      await this.cache.set(cacheIdentity, legacy);
      const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
      return { data: legacy, cached: true, source: 'provider', attempts: 0, creditsRemaining };
    }

    const current = await this.credits.remaining(this.routeId, this.config.credits.starting);
    if (current < 1) throw new ProviderCreditsExhaustedError();

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      try {
        await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
        const started = Date.now();
        const data = await this.client.researchContactByIdentity({
          contactName: input.personName,
          companyName: input.companyName,
          title: input.title,
          linkedinUrl,
        }, async () => { await this.credits.consume(this.routeId, 1); });
        const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
        await this.cache.set(cacheIdentity, data);
        await this.store.upsertPersonCompany(linkedinUrl, companyKey, data);
        await this.saveByLinkedInIfPresent(data);
        const usage = await this.limiter.usage(this.routeId);
        this.machine.onSuccess(Date.now() - started, usage.rpm, usage.rpd);
        logger.info('enrichment.person_company.success', { routeId: this.routeId, attempt, durationMs: Date.now() - started, creditsRemaining, companyName: input.companyName });
        return { data, cached: false, source: 'provider', attempts: attempt, creditsRemaining };
      } catch (error) {
        const classified = classifyProviderError(error);
        if (classified.kind === 'RATE_LIMIT') this.machine.on429(classified.retryAfterSeconds ?? 60);
        else if (classified.kind === 'AUTH') this.machine.onAuthFailure(classified.status ?? 401);
        else if (classified.kind === 'CREDITS') this.machine.onCreditsExhausted(classified.status ?? 422);
        else if (classified.kind === 'TRANSIENT') this.machine.onTransientFailure(classified.status ?? null);
        if (error instanceof ProviderCreditsExhaustedError) throw error;
        if (classified.kind !== 'TRANSIENT' && classified.kind !== 'RATE_LIMIT') throw error;
        if (attempt >= this.config.maxAttempts) throw error;
        const delay = Math.min(8000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Enrichment failed');
  }

  async enrichSearchResult(searchResultId: string): Promise<{ data: EnrichmentResponse; cached: boolean; source: 'provider'; attempts: number; creditsRemaining: number }> {
    const current = await this.credits.remaining(this.routeId, this.config.credits.starting);
    if (current < 1) throw new ProviderCreditsExhaustedError();

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      try {
        await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
        const started = Date.now();
        const data = await this.client.researchContactBySearchResultId(searchResultId, false, async () => { await this.credits.consume(this.routeId, 1); });
        const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
        await this.saveByLinkedInIfPresent(data);
        const usage = await this.limiter.usage(this.routeId);
        this.machine.onSuccess(Date.now() - started, usage.rpm, usage.rpd);
        logger.info('enrichment.success', { routeId: this.routeId, attempt, durationMs: Date.now() - started, creditsRemaining });
        return { data, cached: false, source: 'provider', attempts: attempt, creditsRemaining };
      } catch (error) {
        const classified = classifyProviderError(error);
        if (classified.kind === 'RATE_LIMIT') this.machine.on429(classified.retryAfterSeconds ?? 60);
        else if (classified.kind === 'AUTH') this.machine.onAuthFailure(classified.status ?? 401);
        else if (classified.kind === 'CREDITS') this.machine.onCreditsExhausted(classified.status ?? 422);
        else if (classified.kind === 'TRANSIENT') this.machine.onTransientFailure(classified.status ?? null);
        logger.warn('enrichment.failure', { routeId: this.routeId, attempt, kind: classified.kind, status: classified.status, message: classified.message });
        if (error instanceof ProviderCreditsExhaustedError) throw error;
        if (classified.kind !== 'TRANSIENT' && classified.kind !== 'RATE_LIMIT') throw error;
        if (attempt >= this.config.maxAttempts) throw error;
        const delay = Math.min(8000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Enrichment failed');
  }

  async enrichManySearchResults(searchResultIds: string[]): Promise<{ results: Array<{ searchResultId: string; data?: EnrichmentResponse; error?: string; creditsRemaining: number }>; creditsRemaining: number }> {
    const unique = [...new Set(searchResultIds.filter(Boolean))];
    const remaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
    if (unique.length === 0) throw new Error('Select at least one contact.');
    if (unique.length > remaining) throw new ProviderCreditsExhaustedError(`Only ${remaining} research credit${remaining === 1 ? '' : 's'} remaining; you selected ${unique.length} contact${unique.length === 1 ? '' : 's'}.`);

    const results: Array<{ searchResultId: string; data?: EnrichmentResponse; error?: string; creditsRemaining: number }> = [];
    for (const id of unique) {
      try {
        const result = await this.enrichSearchResult(id);
        results.push({ searchResultId: id, data: result.data, creditsRemaining: result.creditsRemaining });
      } catch (error: any) {
        const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
        results.push({ searchResultId: id, error: error?.message || 'Research failed', creditsRemaining });
      }
    }
    return { results, creditsRemaining: await this.credits.remaining(this.routeId, this.config.credits.starting) };
  }

  private async saveByLinkedInIfPresent(data: EnrichmentResponse): Promise<void> {
    if (!data.linkedinUrl) return;
    const key = cacheKey(data.linkedinUrl);
    await this.store.upsert(data.linkedinUrl, data);
    await this.cache.set(key, data);
  }

  async enrich(normalizedUrl: string): Promise<{ data: EnrichmentResponse; cached: boolean; source: 'supabase' | 'redis' | 'provider'; attempts: number }> {
    const key = cacheKey(normalizedUrl);
    const persisted = await this.store.get(normalizedUrl);
    if (persisted) { await this.cache.set(key, persisted); return { data: persisted, cached: true, source: 'supabase', attempts: 0 }; }
    const redisCached = await this.cache.get(key);
    if (redisCached) return { data: redisCached, cached: true, source: 'redis', attempts: 0 };
    const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let ownsLock = await this.acquireLock(key, lockToken);
    if (!ownsLock) {
      const existing = await this.waitForExistingEnrichment(key, normalizedUrl);
      if (existing) { await this.cache.set(key, existing); return { data: existing, cached: true, source: 'supabase', attempts: 0 }; }
      ownsLock = await this.acquireLock(key, lockToken);
      if (!ownsLock) throw new Error('Another enrichment is still in progress; please retry.');
    }
    try {
      const secondPersisted = await this.store.get(normalizedUrl);
      if (secondPersisted) { await this.cache.set(key, secondPersisted); return { data: secondPersisted, cached: true, source: 'supabase', attempts: 0 }; }
      for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
        try {
          await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
          const started = Date.now();
          const current = await this.credits.remaining(this.routeId, this.config.credits.starting);
          if (current < 1) throw new ProviderCreditsExhaustedError();
          const data = await this.client.researchContactByLinkedInUrl(normalizedUrl, false);
          const creditsRemaining = await this.credits.consume(this.routeId, 1);
          await this.store.upsert(normalizedUrl, data);
          await this.cache.set(key, data);
          const usage = await this.limiter.usage(this.routeId);
        this.machine.onSuccess(Date.now() - started, usage.rpm, usage.rpd);
          logger.info('enrichment.success', { routeId: this.routeId, attempt, durationMs: Date.now() - started, creditsRemaining });
          return { data, cached: false, source: 'provider', attempts: attempt };
        } catch (error) {
          const classified = classifyProviderError(error);
          if (error instanceof ProviderCreditsExhaustedError) throw error;
          if (classified.kind !== 'TRANSIENT' && classified.kind !== 'RATE_LIMIT') throw error;
          if (attempt >= this.config.maxAttempts) throw error;
          const delay = Math.min(8000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      throw new Error('Enrichment failed');
    } finally { if (ownsLock) await this.releaseLock(key, lockToken); }
  }

  async status() {
    const route = await this.machine.snapshot();
    const usage = await this.limiter.usage(this.routeId);
    const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
    return { route, usage, creditsRemaining, creditsLimit: this.config.credits.starting };
  }

  async ready() { await this.redis.ping(); }
}
