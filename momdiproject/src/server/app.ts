import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { loadConfig } from '../config';
import { EnrichmentService } from '../http/enrichment';
import { normalizeLinkedInUrl } from '../utils/normalizeUrl';
import { logger } from '../utils/logger';
import { classifyProviderError } from '../http/errors';
import { ProviderCreditsExhaustedError } from '../core/creditLedger';

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function createApp() {
  const config = loadConfig();
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) throw new Error('Missing required secret REDIS_URL');

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 8000,
  });
  redis.on('error', err => logger.error('redis.error', { message: err.message }));
  await redis.connect();
  await redis.ping();

  const enrichment = new EnrichmentService(config, redis);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb', strict: true }));

  const publicDir = path.resolve(__dirname, 'public');
  app.use(express.static(publicDir, { index: 'chatbox.html' }));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'chatbox.html')));
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

  const expectedToken = process.env.APP_AUTH_TOKEN?.trim();
  const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!expectedToken) return res.status(503).json({ error: 'Authentication is not configured' });
    const auth = req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !timingSafeEqualString(auth.slice(7), expectedToken)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };

  app.get('/ready', async (_req, res) => {
    try { await redis.ping(); await enrichment.ready(); res.status(200).json({ status: 'ready' }); }
    catch (error: any) { res.status(503).json({ status: 'not_ready', error: error?.message || 'dependencies unavailable' }); }
  });

  app.get('/status', authenticate, async (_req, res, next) => {
    try { res.json(await enrichment.status()); } catch (error) { next(error); }
  });

  app.post('/v1/person/resolve', authenticate, async (req, res, next) => {
    try {
      const raw = req.body?.linkedinUrl ?? req.body?.linkedin_url;
      if (typeof raw !== 'string' || raw.length > 2048) return res.status(400).json({ error: 'Enter a valid LinkedIn profile URL.' });
      const normalized = normalizeLinkedInUrl(raw);
      const data = await enrichment.resolvePersonCompanies(normalized);
      res.json(data);
    } catch (error: any) {
      if (error?.message === 'Seamless could not find this LinkedIn profile') return res.status(404).json({ error: error.message });
      next(error);
    }
  });

  app.post('/v1/search/companies', authenticate, async (req, res, next) => {
    try {
      const query = req.body?.query;
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200) return res.status(400).json({ error: 'Enter a valid company name.' });
      res.json(await enrichment.searchCompanies(query, Math.min(Number(req.body?.limit) || 20, 50)));
    } catch (error) { next(error); }
  });

  app.post('/v1/search/contacts', authenticate, async (req, res, next) => {
    try {
      const companyName = typeof req.body?.companyName === 'string' ? req.body.companyName : undefined;
      const companyDomain = typeof req.body?.companyDomain === 'string' ? req.body.companyDomain : undefined;
      if (!companyName && !companyDomain) return res.status(400).json({ error: 'Select a company first.' });
      res.json(await enrichment.searchContacts({ companyName, companyDomain, limit: Math.min(Number(req.body?.limit) || 20, 100), nextToken: typeof req.body?.nextToken === 'string' ? req.body.nextToken : null }));
    } catch (error) { next(error); }
  });

  app.post('/v1/enrich-selected', authenticate, async (req, res, next) => {
    try {
      const ids = req.body?.searchResultIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id: unknown) => typeof id !== 'string' || id.length < 1)) return res.status(400).json({ error: 'Select at least one contact.' });
      if (ids.length > 20) return res.status(400).json({ error: 'Select up to 20 contacts at a time.' });
      res.json(await enrichment.enrichManySearchResults(ids));
    } catch (error: any) {
      if (error instanceof ProviderCreditsExhaustedError) return res.status(402).json({ error: error.message });
      if (error?.name === 'QuotaExceededError') return res.status(429).json({ error: error.message });
      const classified = classifyProviderError(error);
      if (classified.kind === 'AUTH') return res.status(502).json({ error: 'Provider authorization failed. Check the configured Seamless access.' });
      if (classified.kind === 'CREDITS') return res.status(402).json({ error: 'Provider credits are unavailable.' });
      if (classified.kind === 'RATE_LIMIT') return res.status(503).json({ error: 'Provider rate limit reached. Please retry later.' });
      next(error);
    }
  });

  app.post('/v1/enrich', authenticate, async (req, res) => {
    try {
      const raw = req.body?.linkedinUrl ?? req.body?.linkedin_url;
      if (typeof raw !== 'string' || raw.length > 2048) return res.status(400).json({ error: 'linkedinUrl must be a valid string' });
      const normalized = normalizeLinkedInUrl(raw);
      const result = await enrichment.enrich(normalized);
      res.json(result);
    } catch (error: any) {
      const classified = classifyProviderError(error);
      logger.warn('http.enrichment.failure', { kind: classified.kind, status: classified.status, message: classified.message });
      if (error?.name === 'QuotaExceededError') return res.status(429).json({ error: error.message });
      if (error instanceof ProviderCreditsExhaustedError) return res.status(402).json({ error: 'Provider credits are exhausted.' });
      if (error?.message === 'Seamless could not find this LinkedIn profile') return res.status(404).json({ error: error.message });
      if (classified.kind === 'AUTH') return res.status(502).json({ error: 'Provider authorization failed. Check the Seamless API key and Public API access.' });
      if (classified.kind === 'CREDITS') return res.status(402).json({ error: 'Provider credits or license are unavailable.' });
      if (classified.kind === 'RATE_LIMIT') return res.status(503).json({ error: 'Provider rate limit reached. Please retry later.' });
      if (classified.kind === 'VALIDATION') return res.status(422).json({ error: classified.message });
      if (error?.message?.startsWith('Supabase ')) return res.status(503).json({ error: 'Persistent storage temporarily unavailable.' });
      if (classified.kind === 'TRANSIENT') return res.status(503).json({ error: 'Seamless is temporarily unavailable. Please retry.' });
      res.status(503).json({ error: 'Enrichment temporarily unavailable.' });
    }
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('http.unhandled_error', { message: err?.message });
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
