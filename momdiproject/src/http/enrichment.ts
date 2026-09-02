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

export class EnrichmentService {
  private readonly limiter: RateLimiter;
  private readonly cache: EnrichmentCache;
  private readonly machine: RouteStateMachine;
  private readonly client;
  private readonly routeId = 'primary';

  constructor(private readonly config: ServiceConfig, redis: Redis) {
    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing required secret ${config.apiKeyEnv}`);
    this.limiter = new RateLimiter(redis);
    this.cache = new EnrichmentCache(redis, config.cacheTtlSeconds);
    this.machine = new RouteStateMachine(this.routeId, config.limits.rpm, config.limits.rpd);
    this.client = createProviderClient(config.providerBaseUrl, apiKey, config.requestTimeoutMs);
  }

  async enrich(normalizedUrl: string): Promise<{ data: EnrichmentResponse; cached: boolean; attempts: number }> {
    const key = cacheKey(normalizedUrl);
    const cached = await this.cache.get(key);
    if (cached) return { data: cached, cached: true, attempts: 0 };

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        const usage = await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
        const started = Date.now();
        const data = await this.client.enrich(this.config.providerPath, normalizedUrl);
        const durationMs = Date.now() - started;
        this.machine.onSuccess(durationMs, usage.rpm, usage.rpd);
        await this.cache.set(key, data);
        logger.info('enrichment.success', { routeId: this.routeId, attempt, durationMs });
        return { data, cached: false, attempts: attempt };
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
  }

  async status() {
    const usage = await this.limiter.usage(this.routeId);
    const snapshot = this.machine.snapshot();
    snapshot.rpmRemaining = Math.max(0, snapshot.rpmLimit - usage.rpm);
    snapshot.rpdRemaining = Math.max(0, snapshot.rpdLimit - usage.rpd);
    if (snapshot.status === 'COOLDOWN' && snapshot.cooldownUntil && snapshot.cooldownUntil <= Date.now()) snapshot.status = 'READY';
    return { route: snapshot, usage };
  }
}
