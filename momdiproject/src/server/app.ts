import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { loadConfig } from '../config';
import { EnrichmentService } from '../http/enrichment';
import { normalizeLinkedInUrl } from '../utils/normalizeUrl';
import { logger } from '../utils/logger';

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function createApp() {
  const config = loadConfig();
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) throw new Error('Missing required secret REDIS_URL');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: true });
  redis.on('error', err => logger.error('redis.error', { message: err.message }));
  await redis.connect();
  await redis.ping();
  const enrichment = new EnrichmentService(config, redis);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  const expectedToken = process.env.APP_AUTH_TOKEN?.trim();
  app.use((req, res, next) => {
    const publicPaths = req.path === '/' || req.path === '/health' || req.path === '/ready';
    if (publicPaths) return next();
    if (!expectedToken) return res.status(503).json({ error: 'Authentication is not configured' });
    const auth = req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !timingSafeEqualString(auth.slice(7), expectedToken)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });

  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/ready', async (_req, res) => {
    try { await redis.ping(); await enrichment.ready(); res.status(200).json({ status: 'ready' }); }
    catch (error: any) { res.status(503).json({ status: 'not_ready', error: error?.message || 'dependencies unavailable' }); }
  });
  app.get('/status', async (_req, res, next) => {
    try { res.json(await enrichment.status()); } catch (e) { next(e); }
  });

  app.post('/v1/enrich', async (req, res) => {
    try {
      const raw = req.body?.linkedinUrl ?? req.body?.linkedin_url;
      if (typeof raw !== 'string' || raw.length > 2048) return res.status(400).json({ error: 'linkedinUrl must be a valid string' });
      const normalized = normalizeLinkedInUrl(raw);
      const result = await enrichment.enrich(normalized);
      res.json(result);
    } catch (error: any) {
      logger.warn('http.enrichment.failure', { message: error?.message });
      if (error?.name === 'QuotaExceededError') return res.status(429).json({ error: error.message });
      if (error?.message?.startsWith('Invalid ') || error?.message?.startsWith('Expected ')) return res.status(400).json({ error: error.message });
      const status = error?.response?.status;
      if (status === 401 || status === 403) return res.status(502).json({ error: 'Provider authorization failed' });
      if (status === 429) return res.status(503).json({ error: 'Provider rate limit reached' });
      if (status && status >= 400 && status < 500) return res.status(status).json({ error: 'Provider rejected request' });
      if (error?.message?.startsWith('Supabase ')) return res.status(503).json({ error: 'Persistent storage temporarily unavailable' });
      res.status(503).json({ error: 'Enrichment temporarily unavailable' });
    }
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('http.unhandled_error', { message: err?.message });
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
