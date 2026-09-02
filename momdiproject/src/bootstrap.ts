import { loadConfig } from './config/loader.js';
import { createRedis, redisConnection } from './storage/redis.js';
import { JobQueue } from './queue/jobQueue.js';
import { EnrichmentCache } from './cache/enrichmentCache.js';
import { RouteScheduler } from './quota/scheduler.js';
import { SeamlessClient, EgressIpProbe } from './providers/seamless/client.js';
import { EnrichmentService } from './domain/service.js';

export function createRuntime() {
  const config = loadConfig();
  const redis = createRedis();
  const connection = redisConnection();
  const queue = new JobQueue(connection);
  const cache = new EnrichmentCache(redis, config.cache.ttlSeconds);
  const scheduler = new RouteScheduler(redis, config.routes);
  const clients = new Map<string, SeamlessClient>();
  const ipProbe = new EgressIpProbe(config.network.egressIpCheckUrl, config.network.egressIpCheckTimeoutMs);
  for (const route of config.routes) {
    const apiKey = process.env[route.apiKeyEnv]?.trim();
    if (apiKey) {
      clients.set(route.id, new SeamlessClient(process.env.PROVIDER_BASE_URL ?? 'https://api.seamless.ai', apiKey, config.queue.jobTimeoutMs, ipProbe));
    }
  }
  const service = new EnrichmentService(redis, queue, cache, scheduler, clients, config.queue.maxAttempts);
  return { config, redis, queue, cache, scheduler, clients, service, connection, ipProbe };
}
