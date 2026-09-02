import Redis from 'ioredis';

export function requireRedisUrl(): string {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    throw new Error('REDIS_URL is required in hosted environments. Set it to your Render Key Value internal connection string.');
  }
  return url;
}

export function createRedis(url = process.env.REDIS_URL?.trim() || 'redis://localhost:6379') {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  redis.on('error', (err) => {
    // Prevent ioredis from emitting an unhandled error event.
    // Startup code performs the actual connectivity check and reports the failure.
    console.error('[redis] connection error:', err.message);
  });
  return redis;
}
