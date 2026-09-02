import Redis from 'ioredis';
import { EnrichmentResponse } from '../core/types';
import { z } from 'zod';

const CacheSchema = z.object({
  id: z.string().optional(), fullName: z.string().optional(), firstName: z.string().optional(),
  lastName: z.string().optional(), title: z.string().optional(), company: z.string().optional(),
  email: z.string().optional(), phone: z.string().optional(), linkedinUrl: z.string().url(),
});

export class EnrichmentCache {
  constructor(private readonly redis: Redis, private readonly ttlSeconds: number) {}
  async get(key: string): Promise<EnrichmentResponse | null> {
    const value = await this.redis.get(key);
    if (!value) return null;
    try { return CacheSchema.parse(JSON.parse(value)); }
    catch { await this.redis.del(key); return null; }
  }
  async set(key: string, value: EnrichmentResponse) {
    await this.redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds);
  }
}
