import { randomUUID } from 'node:crypto';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface EnrichmentJob {
  id: string;
  normalizedUrl: string;
  createdAt: number;
  attempts: number;
  maxAttempts: number;
  status: JobStatus;
  result?: Record<string, unknown>;
  error?: string;
}

export function createJob(normalizedUrl: string, maxAttempts: number): EnrichmentJob {
  return { id: randomUUID(), normalizedUrl, createdAt: Date.now(), attempts: 0, maxAttempts, status: 'queued' };
}
