import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import type Redis from 'ioredis';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './observability/logger.js';
import { healthRoutes } from './api/routes/health.js';
import { enrichmentRoutes } from './api/routes/enrichment.js';
import { adminRoutes } from './api/routes/admin.js';
import { bearerAuth } from './api/middleware/auth.js';
import { redisFixedWindowLimit } from './api/middleware/rateLimit.js';
import { errorHandler } from './api/middleware/errorHandler.js';
import type { EnrichmentService } from './domain/service.js';
import type { JobQueue } from './queue/jobQueue.js';
import type { RouteScheduler } from './quota/scheduler.js';
import { registry } from './observability/metrics.js';
import { EgressIpProbe } from './providers/seamless/client.js';

export function createApp(redis: Redis, service: EnrichmentService, queue: JobQueue, scheduler: RouteScheduler, ipProbe: EgressIpProbe) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use((req, _res, next) => { if (!req.header('x-request-id')) req.headers['x-request-id'] = crypto.randomUUID(); next(); });
  app.use(pinoHttp({ logger }));
  app.use(helmet());
  app.use(express.json({ limit: '32kb' }));
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  app.use(express.static(publicDir));
  app.use(healthRoutes(redis));
  app.get('/metrics', bearerAuth(process.env.ADMIN_API_TOKEN), async (_req, res) => { res.setHeader('Content-Type', registry.contentType); res.end(await registry.metrics()); });
  app.use('/api', bearerAuth(process.env.APP_API_TOKEN), redisFixedWindowLimit(redis, Number(process.env.APP_RPM_LIMIT ?? 60), 60), enrichmentRoutes(service, queue));
  app.use('/admin', bearerAuth(process.env.ADMIN_API_TOKEN), adminRoutes(scheduler, queue, ipProbe));
  app.use(errorHandler);
  return app;
}
