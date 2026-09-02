import Redis from 'ioredis';
import { ServiceConfig } from '../config/schema';
import { RateLimiter, QuotaExceededError } from '../core/rateLimiter';
import { RouteStateMachine } from '../core/stateMachine';
import { EnrichmentResponse } from '../core/types';
import { classifyProviderError } from './errors';
import { CompanySearchResult, ContactSearchResult, SeamlessClient } from './client';
import { EnrichmentCache } from '../cache/enrichmentCache';
import { cacheKey, normalizeLinkedInUrl } from '../utils/normalizeUrl';
import { logger } from '../utils/logger';
import { SupabaseStore } from '../storage/supabase';
import { CreditLedger, ProviderCreditsExhaustedError } from '../core/creditLedger';

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

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

  async searchCompanies(query: string, limit = 20): Promise<{ companies: CompanySearchResult[]; total?: number; nextToken?: string | null }> {
    if (!query.trim()) throw new Error('Enter a company name to search.');
    await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
    return this.client.searchCompanies(query.trim(), limit);
  }

  async searchContacts(input: { companyName?: string; companyDomain?: string; limit?: number; nextToken?: string | null }): Promise<{ contacts: ContactSearchResult[]; total?: number; nextToken?: string | null }> {
    if (!input.companyName?.trim() && !input.companyDomain?.trim()) throw new Error('Select a company first.');
    await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
    return this.client.searchContacts(input);
  }

  async resolvePersonCompanies(linkedinUrl: string): Promise<{ person: EnrichmentResponse; companies: Array<{ name: string; title?: string; startedAt?: string; endedAt?: string; current: boolean; domain?: string }>; creditsRemaining: number; cached: boolean }> {
    const normalized = normalizeLinkedInUrl(linkedinUrl);
    const key = cacheKey(normalized);
    const persisted = await this.store.get(normalized);
    if (persisted) {
      const companies = this.extractCompanies(persisted);
      return { person: persisted, companies, creditsRemaining: await this.credits.remaining(this.routeId, this.config.credits.starting), cached: true };
    }
    const redisCached = await this.cache.get(key);
    if (redisCached) {
      const companies = this.extractCompanies(redisCached);
      return { person: redisCached, companies, creditsRemaining: await this.credits.remaining(this.routeId, this.config.credits.starting), cached: true };
    }
    const current = await this.credits.remaining(this.routeId, this.config.credits.starting);
    if (current < 1) throw new ProviderCreditsExhaustedError('At least 1 research credit is required to identify this person and load their work history.');
    await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
    try {
      const person = await this.client.researchContactByLinkedInUrl(normalized, false, async () => {
        await this.credits.consume(this.routeId, 1);
      });
      await this.saveByLinkedInIfPresent(person);
      const companies = this.extractCompanies(person);
      return { person, companies, creditsRemaining: await this.credits.remaining(this.routeId, this.config.credits.starting), cached: false };
    } catch (error) {
      const classified = classifyProviderError(error);
      if (classified.kind === 'RATE_LIMIT') this.machine.on429(classified.retryAfterSeconds ?? 60);
      else if (classified.kind === 'AUTH') this.machine.onAuthFailure(classified.status ?? 401);
      else if (classified.kind === 'CREDITS') this.machine.onCreditsExhausted(classified.status ?? 422);
      else if (classified.kind === 'TRANSIENT') this.machine.onTransientFailure(classified.status ?? null);
      throw error;
    }
  }

  private extractCompanies(person: EnrichmentResponse): Array<{ name: string; title?: string; startedAt?: string; endedAt?: string; current: boolean; domain?: string }> {
    const history = Array.isArray(person.jobHistory) ? person.jobHistory : [];
    type CompanyHistoryEntry = {
      name: string;
      title?: string;
      startedAt?: string;
      endedAt?: string;
      current: boolean;
      domain?: string;
    };

    const mapped: CompanyHistoryEntry[] = [];
    history.forEach((job: Record<string, unknown>, index: number) => {
      const name = [job.company, job.companyName, job.companyOriginal].find(v => typeof v === 'string' && v.trim()) as string | undefined;
      if (!name) return;
      const title = [job.title, job.jobTitle].find(v => typeof v === 'string' && v.trim()) as string | undefined;
      const startedAt = [job.startedAt, job.startDate, job.startDateAt, job.from].find(v => typeof v === 'string' && v.trim()) as string | undefined;
      const endedAt = [job.endedAt, job.endDate, job.endDateAt, job.to].find(v => typeof v === 'string' && v.trim()) as string | undefined;
      const domain = [job.companyDomain, job.domain, job.website].find(v => typeof v === 'string' && v.trim()) as string | undefined;
      const currentFlag = job.current === true || job.isCurrent === true || (!endedAt && index === 0);
      mapped.push({ name: name.trim(), title, startedAt, endedAt, current: currentFlag, domain: domain?.trim() });
    });

    if (!mapped.length && person.company) {
      return [{ name: person.company, title: person.title, current: true, domain: person.companyDomain }];
    }

    const seen = new Set<string>();
    return mapped.filter(item => {
      const key = `${item.name.toLowerCase()}|${(item.title ?? '').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
