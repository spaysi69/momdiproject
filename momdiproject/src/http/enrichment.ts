import Redis from 'ioredis';
import { ServiceConfig } from '../config/schema';
import { RateLimiter, QuotaExceededError } from '../core/rateLimiter';
import { RouteStateMachine } from '../core/stateMachine';
import { EnrichmentResponse } from '../core/types';
import { classifyProviderError } from './errors';
import { createProviderClient } from './client';
import { EnrichmentCache } from '../cache/enrichmentCache';
import { cacheKey } from '../utils/normalizeUrl';
import { logger } from '../utils/logger';
import { SupabaseStore } from '../storage/supabase';

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
  private readonly client;
  private readonly store: SupabaseStore;
  private readonly routeId = 'primary';

  constructor(private readonly config: ServiceConfig, redis: Redis) {
    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing required secret ${config.apiKeyEnv}`);
    this.limiter = new RateLimiter(redis);
    this.cache = new EnrichmentCache(redis, config.cacheTtlSeconds);
    this.machine = new RouteStateMachine(this.routeId, config.limits.rpm, config.limits.rpd);
    this.client = createProviderClient(config.providerBaseUrl, apiKey, config.requestTimeoutMs);
    this.store = new SupabaseStore();
    this.redis = redis;
  }

  private readonly redis: Redis;

  private async acquireLock(key: string, token: string, ttlSeconds = 60): Promise<boolean> {
    return (await this.redis.set(`enrich:lock:${key}`, token, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, `enrich:lock:${key}`, token);
  }

  private async waitForExistingEnrichment(key: string, normalizedUrl: string): Promise<EnrichmentResponse | null> {
    for (let i = 0; i < 60; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 500));
      const persisted = await this.store.get(normalizedUrl);
      if (persisted) return persisted;
      const redisCached = await this.cache.get(key);
      if (redisCached) return redisCached;
      const lockExists = await this.redis.exists(`enrich:lock:${key}`);
      if (!lockExists) return null;
    }
    return null;
  }

  async enrich(normalizedUrl: string): Promise<{ data: EnrichmentResponse; cached: boolean; source: 'supabase' | 'redis' | 'provider'; attempts: number }> {
    const key = cacheKey(normalizedUrl);

    const persisted = await this.store.get(normalizedUrl);
    if (persisted) {
      await this.cache.set(key, persisted);
      return { data: persisted, cached: true, source: 'supabase', attempts: 0 };
    }

    const redisCached = await this.cache.get(key);
    if (redisCached) {
      return { data: redisCached, cached: true, source: 'redis', attempts: 0 };
    }

    const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let ownsLock = await this.acquireLock(key, lockToken);
    if (!ownsLock) {
      const existing = await this.waitForExistingEnrichment(key, normalizedUrl);
      if (existing) {
        await this.cache.set(key, existing);
        return { data: existing, cached: true, source: 'supabase', attempts: 0 };
      }
      // The lock may have expired after an owner crash. Try to acquire it before calling the provider.
      const reacquired = await this.acquireLock(key, lockToken);
      if (!reacquired) {
        const finalCheck = await this.store.get(normalizedUrl);
        if (finalCheck) return { data: finalCheck, cached: true, source: 'supabase', attempts: 0 };
        throw new Error('Another enrichment is still in progress; please retry.');
      }
      ownsLock = true;
    }

    try {
      // Double-check after acquiring the lock to eliminate the common cache-miss race.
      const secondPersisted = await this.store.get(normalizedUrl);
      if (secondPersisted) {
        await this.cache.set(key, secondPersisted);
        return { data: secondPersisted, cached: true, source: 'supabase', attempts: 0 };
      }

      let lastError: unknown;
      for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
        try {
          const usage = await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
          const started = Date.now();
          const data = await this.client.enrich(this.config.providerPath, normalizedUrl);
          const durationMs = Date.now() - started;
          this.machine.onSuccess(durationMs, usage.rpm, usage.rpd);

          // Durable cache first; Redis is a fast secondary cache.
          await this.store.upsert(normalizedUrl, data);
          await this.cache.set(key, data);

          logger.info('enrichment.success', { routeId: this.routeId, attempt, durationMs, cache: 'supabase+redis' });
          return { data, cached: false, source: 'provider', attempts: attempt };
        } catch (error) {
          lastError = error;
          if (error instanceof QuotaExceededError) throw error;
          const classified = classifyProviderError(error);
          if (classified.kind === 'RATE_LIMIT') {
            const retryAfter = classified.retryAfterSeconds ?? 60;
            await this.limiter.setCooldown(this.routeId, retryAfter);
            this.machine.on429(retryAfter);
          } else if (classified.kind === 'AUTH') {
            this.machine.onAuthFailure(classified.status ?? 0);
          } else if (classified.kind === 'CREDITS') {
            this.machine.onCreditsExhausted(classified.status ?? 422);
          } else if (classified.kind === 'TRANSIENT') {
            this.machine.onTransientFailure(classified.status ?? null);
          }
          logger.warn('enrichment.failure', { routeId: this.routeId, attempt, kind: classified.kind, status: classified.status });
          if (!classified.retryable || attempt === this.config.maxAttempts) throw error;
          const exponential = Math.min(10_000, 500 * 2 ** (attempt - 1));
          const retryAfter = classified.retryAfterSeconds ? Math.min(10_000, classified.retryAfterSeconds * 1000) : 0;
          const delay = Math.max(exponential, retryAfter) + Math.floor(Math.random() * 250);
          await new Promise<void>(resolve => setTimeout(resolve, delay));
        }
      }
      throw lastError ?? new Error('Enrichment failed');
    } finally {
      if (ownsLock) await this.releaseLock(key, lockToken);
    }
  }

  async status() {
    const usage = await this.limiter.usage(this.routeId);
    const snapshot = this.machine.snapshot();
    snapshot.rpmRemaining = Math.max(0, snapshot.rpmLimit - usage.rpm);
    snapshot.rpdRemaining = Math.max(0, snapshot.rpdLimit - usage.rpd);
    if (snapshot.status === 'COOLDOWN' && snapshot.cooldownUntil && snapshot.cooldownUntil <= Date.now()) snapshot.status = 'READY';
    return { route: snapshot, usage };
  }

  async ready(): Promise<void> {
    await this.store.ping();
  }
}
