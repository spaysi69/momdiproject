import { UnrecoverableError, type Job } from 'bullmq';
import type Redis from 'ioredis';
import { EnrichmentResponseSchema, type EnrichmentResponse } from './enrichment.js';
import type { EnrichmentJob } from './jobs/job.js';
import type { EnrichmentCache } from '../cache/enrichmentCache.js';
import type { JobQueue } from '../queue/jobQueue.js';
import type { ProviderClient } from '../providers/seamless/client.js';
import type { RouteScheduler } from '../quota/scheduler.js';
import { AppError } from '../utils/errors.js';
import { normalizeLinkedInUrl } from '../utils/normalizeUrl.js';
import { providerCalls, providerLatency, requests } from '../observability/metrics.js';
import { createJob } from './jobs/job.js';

export class EnrichmentService {
  constructor(
    private readonly redis: Redis,
    private readonly queue: JobQueue,
    private readonly cache: EnrichmentCache,
    private readonly scheduler: RouteScheduler,
    private readonly clients: Map<string, ProviderClient>,
    private readonly maxAttempts: number,
  ) {}

  async submit(rawUrl: string): Promise<{ cached: boolean; queued: boolean; result?: EnrichmentResponse; jobId?: string }> {
    const normalizedUrl = normalizeLinkedInUrl(rawUrl);
    const cached = await this.cache.get<EnrichmentResponse>(normalizedUrl);
    if (cached) { requests.inc({ outcome: 'cache_hit' }); return { cached: true, queued: false, result: cached }; }

    const dedupeKey = `dedupe:enrichment:${Buffer.from(normalizedUrl).toString('base64url')}`;
    const existing = await this.redis.get(dedupeKey);
    if (existing) { requests.inc({ outcome: 'dedupe_hit' }); return { cached: false, queued: true, jobId: existing }; }

    const job = createJob(normalizedUrl, this.maxAttempts);
    const reserved = await this.redis.set(dedupeKey, job.id, 'EX', 3600, 'NX');
    if (reserved !== 'OK') {
      const existingId = await this.redis.get(dedupeKey);
      if (existingId) return { cached: false, queued: true, jobId: existingId };
    }
    await this.queue.enqueue(job);
    requests.inc({ outcome: 'queued' });
    return { cached: false, queued: true, jobId: job.id };
  }

  async process(job: Job<EnrichmentJob>): Promise<void> {
    const data = job.data;
    const route = await this.scheduler.acquire();
    if (!route) throw new AppError('rate_limit', 'No authorized route currently has capacity', true);
    const client = this.clients.get(route.id);
    if (!client) { await this.scheduler.markAuthFailed(route.id); throw new AppError('auth', `No credential configured for route ${route.id}`, false); }
    const started = Date.now();
    try {
      const result = EnrichmentResponseSchema.parse(await client.enrich(data.normalizedUrl));
      await this.cache.set(data.normalizedUrl, result);
      await this.scheduler.markSuccess(route.id, Date.now() - started);
      const probeClient = client as ProviderClient & { getObservedEgressIp?: () => Promise<{ ip: string | null }> };
      if (typeof probeClient.getObservedEgressIp === 'function') {
        void probeClient.getObservedEgressIp()
          .then(({ ip }) => this.scheduler.updateObservedEgressIp(route.id, ip))
          .catch(() => undefined);
      }
      providerCalls.inc({ route: route.id, outcome: 'success' }); providerLatency.observe({ route: route.id }, (Date.now() - started) / 1000);
      await job.updateData({ ...data, status: 'completed', result });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('unknown', 'Unexpected provider error', false);
      const creditError = /insufficientcredits|insufficient credit/i.test(appError.message);
      if (creditError) await this.scheduler.markCreditsExhausted(route.id);
      else if (appError.kind === 'auth') await this.scheduler.markAuthFailed(route.id);
      else if (appError.kind === 'rate_limit') { const match = /retry_after=(\d+)/i.exec(appError.message); await this.scheduler.markRateLimited(route.id, Number(match?.[1] ?? 60)); }
      else if (appError.retryable) await this.scheduler.markTransientFailure(route.id);
      else await this.redis.del(`dedupe:enrichment:${Buffer.from(data.normalizedUrl).toString('base64url')}`);
      providerCalls.inc({ route: route.id, outcome: appError.kind }); providerLatency.observe({ route: route.id }, (Date.now() - started) / 1000);
      if (!appError.retryable) throw new UnrecoverableError(appError.message);
      throw appError;
    }
  }
}
