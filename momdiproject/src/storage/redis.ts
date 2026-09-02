import Redis from 'ioredis';
export function createRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  return new Redis(url, { maxRetriesPerRequest: 2 });
}
