import type Redis from 'ioredis';
import { cacheKey } from '../utils/normalizeUrl.js';

export class EnrichmentCache {
  constructor(private readonly redis: Redis, private readonly ttlSeconds: number) {}
  async get<T>(normalizedUrl: string): Promise<T | null> {
    const value = await this.redis.get(cacheKey(normalizedUrl));
    return value ? JSON.parse(value) as T : null;
  }
  async set<T>(normalizedUrl: string, value: T): Promise<void> {
    await this.redis.set(cacheKey(normalizedUrl), JSON.stringify(value), 'EX', this.ttlSeconds);
  }
}
