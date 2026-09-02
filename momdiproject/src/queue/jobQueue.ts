import { Queue, QueueEvents, type Job } from 'bullmq';
import type { EnrichmentJob } from '../domain/jobs/job.js';

export class JobQueue {
  readonly queue: Queue<EnrichmentJob>;
  readonly events: QueueEvents;
  constructor(redisConnection: { host: string; port: number; password?: string }) {
    this.queue = new Queue<EnrichmentJob>('enrichment', { connection: redisConnection, defaultJobOptions: { removeOnComplete: { age: 86400 }, removeOnFail: { age: 7 * 86400 } } });
    this.events = new QueueEvents('enrichment', { connection: redisConnection });
  }
  async enqueue(job: EnrichmentJob, delayMs = 0): Promise<void> {
    await this.queue.add('enrich', job, { jobId: job.id, delay: delayMs, attempts: job.maxAttempts, backoff: { type: 'exponential', delay: 1000 } });
  }
  async get(jobId: string): Promise<EnrichmentJob | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    const data = job.data;
    return { ...data, status: mapState(job) };
  }
  async stats() {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
    return counts;
  }
  async close() { await Promise.all([this.events.close(), this.queue.close()]); }
}
function mapState(job: Job<EnrichmentJob>): EnrichmentJob['status'] {
  if (job.failedReason) return 'failed';
  if (job.finishedOn) return 'completed';
  if (job.processedOn) return 'processing';
  return job.delay && job.delay > Date.now() ? 'queued' : 'queued';
}
