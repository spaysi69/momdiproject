import { Worker } from 'bullmq';
import { createRuntime } from './bootstrap.js';
import { redisConnection } from './storage/redis.js';
import { logger } from './observability/logger.js';
import type { EnrichmentJob } from './domain/jobs/job.js';

const runtime = createRuntime();
const concurrency = Math.max(1, Number(process.env.QUEUE_CONCURRENCY ?? 4));
const worker = new Worker<EnrichmentJob>('enrichment', job => runtime.service.process(job), {
  connection: redisConnection(),
  concurrency,
  autorun: true,
  stalledInterval: 30_000,
  maxStalledCount: 1,
});
worker.on('completed', job => logger.info({ jobId: job.id }, 'Job completed'));
worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err }, 'Job failed'));
worker.on('error', err => logger.error({ err }, 'Worker error'));

const shutdown = async () => { await worker.close(); await runtime.redis.quit(); await runtime.queue.close(); process.exit(0); };
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
