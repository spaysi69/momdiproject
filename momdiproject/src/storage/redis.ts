import Redis from 'ioredis';

export function redisConnection(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  const parsed = new URL(url);
  const connection: { host: string; port: number; password?: string } = { host: parsed.hostname, port: Number(parsed.port || 6379) };
  if (parsed.password) connection.password = decodeURIComponent(parsed.password);
  return connection;
}

export function createRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379'): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}
