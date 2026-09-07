import Redis from 'ioredis';
import { z } from 'zod';
import { EnrichmentResponse } from '../core/types';

const CacheSchema = z.object({
  id: z.string().optional(),
  fullName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().url(),
  department: z.string().optional(),
  seniority: z.string().optional(),
  alternateEmails: z.array(z.string()).optional(),
  alternatePhones: z.array(z.string()).optional(),
  companyDomain: z.string().optional(),
  companyLinkedInUrl: z.string().optional(),
  contactLocation: z.record(z.string(), z.any()).optional(),
  companyLocation: z.record(z.string(), z.any()).optional(),
  raw: z.record(z.string(), z.any()).optional(),
});

export class EnrichmentCache {
  constructor(private readonly redis: Redis, private readonly ttlSeconds: number) {}
  async get(key: string): Promise<EnrichmentResponse | null> {
    const value = await this.redis.get(key);
    if (!value) return null;
    try { return CacheSchema.parse(JSON.parse(value)); }
    catch { await this.redis.del(key); return null; }
  }
  async set(key: string, value: EnrichmentResponse): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds);
  }
}
