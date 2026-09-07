import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { loadConfig } from '../config';
import { EnrichmentService } from '../http/enrichment';
import { logger } from '../utils/logger';

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function errorMessage(error: any): string { return error?.message || String(error); }

export async function createApp() {
  const config = loadConfig();
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) throw new Error('Missing required secret REDIS_URL');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: true, connectTimeout: 8000 });
  redis.on('error', err => logger.error('redis.error', { message: err.message }));
  await redis.connect();
  await redis.ping();

  const enrichment = new EnrichmentService(config, redis);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '32kb', strict: true }));
  const publicDir = path.resolve(__dirname, 'public');
  app.use(express.static(publicDir, { index: 'chatbox.html' }));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'chatbox.html')));
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', version: '27.0.0' }));

  const expectedToken = process.env.APP_AUTH_TOKEN?.trim();
  const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!expectedToken) return res.status(503).json({ error: 'Authentication is not configured' });
    const auth = req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !timingSafeEqualString(auth.slice(7), expectedToken)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };

  app.get('/ready', async (_req, res) => {
    try { await enrichment.ready(); res.status(200).json({ status: 'ready' }); }
    catch (error: any) { res.status(503).json({ status: 'not_ready', error: errorMessage(error) }); }
  });
  app.get('/status', authenticate, async (_req, res) => res.json(await enrichment.status()));

  app.post('/v1/contacts/search', authenticate, async (req, res, next) => {
    const filters: Record<string, unknown> = {};
    for (const key of ['companyName', 'jobTitle', 'fullname', 'seniority']) {
      const value = req.body?.[key];
      if (value !== undefined) {
        if (!Array.isArray(value) || value.length > 20 || value.some(x => typeof x !== 'string' || x.length > 200)) return res.status(400).json({error:`Invalid ${key} filter`});
        if (value.length) filters[key] = value;
      }
    }
    if (!Object.keys(filters).length) return res.status(400).json({error:'Enter at least a company, name, or job title.'});
    const limit = req.body?.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({error:'Limit must be between 1 and 100.'});
    filters.limit = limit;
    try { res.json(await enrichment.searchContacts(filters)); } catch (error) { next(error); }
  });

  app.post('/v1/person/search', authenticate, async (req, res) => {
    try {
      const linkedinUrl = typeof req.body?.linkedinUrl === 'string' ? req.body.linkedinUrl.trim() : '';
      if (!linkedinUrl) return res.status(400).json({ error: 'Enter a LinkedIn person URL.' });
      return res.json(await enrichment.searchPerson(linkedinUrl));
    } catch (error: any) {
      const msg = errorMessage(error);
      const code = String(error?.code || '');
      if (/valid LinkedIn person URL|No Seamless contact record matched/i.test(msg)) return res.status(422).json({ error: msg });
      if (code.startsWith('HTTP_401') || /authorization|scope|not enabled|unauthorized/i.test(msg)) return res.status(502).json({ error: `Seamless MCP authorization failed: ${msg}` });
      if (/429|rate limit/i.test(msg)) return res.status(503).json({ error: `Seamless MCP rate limit reached: ${msg}` });
      logger.error('http.person.search', { error: msg, stack: error?.stack });
      return res.status(502).json({ error: `Seamless free person search failed: ${msg}` });
    }
  });

  app.post('/v1/person/research', authenticate, async (req, res) => {
    try {
      const linkedinUrl = typeof req.body?.linkedinUrl === 'string' ? req.body.linkedinUrl.trim() : '';
      const searchResultId = typeof req.body?.searchResultId === 'string' ? req.body.searchResultId.trim() : '';
      const personName = typeof req.body?.personName === 'string' ? req.body.personName.trim() : undefined;
      const companyName = typeof req.body?.companyName === 'string' ? req.body.companyName.trim() : undefined;
      if (!searchResultId) return res.status(400).json({ error: 'searchResultId is required.' });
      const result = await enrichment.startResearch({ linkedinUrl, searchResultId, personName, companyName });
      return res.status(result.status === 'processing' ? 202 : 200).json(result);
    } catch (error: any) {
      const msg = errorMessage(error);
      if (/credits?|insufficient|license/i.test(msg)) return res.status(402).json({ error: `Provider credits unavailable: ${msg}` });
      if (/authorization|scope|unauthorized|not enabled/i.test(msg)) return res.status(502).json({ error: `Seamless MCP authorization failed: ${msg}` });
      if (/429|rate limit/i.test(msg)) return res.status(503).json({ error: `Seamless MCP rate limit reached: ${msg}` });
      logger.error('http.person.research', { error: msg, stack: error?.stack });
      return res.status(502).json({ error: `Seamless contact research failed: ${msg}` });
    }
  });

  app.post('/v1/person/research/status', authenticate, async (req, res) => {
    try {
      const linkedinUrl = typeof req.body?.linkedinUrl === 'string' ? req.body.linkedinUrl.trim() : '';
      if (!req.body.searchResultId && !linkedinUrl) return res.status(400).json({ error: 'searchResultId is required.' });
      const result = await enrichment.pollResearch(req.body.searchResultId || linkedinUrl);
      if (result.status === 'not_found') return res.status(404).json({ error: 'No active research job was found.' });
      return res.status(result.status === 'processing' ? 202 : 200).json(result);
    } catch (error: any) {
      const msg = errorMessage(error);
      if (/credits?|insufficient|license/i.test(msg)) return res.status(402).json({ error: `Provider credits unavailable: ${msg}` });
      if (/authorization|scope|unauthorized|not enabled/i.test(msg)) return res.status(502).json({ error: `Seamless MCP authorization failed: ${msg}` });
      return res.status(502).json({ error: `Seamless research polling failed: ${msg}` });
    }
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('http.unhandled_error', { message: errorMessage(err), stack: err?.stack });
    const code = String(err?.code || '');
    const status = err?.type === 'entity.parse.failed' ? 400 : /401|403/.test(code) ? 502 : /429/.test(code) ? 503 : 502;
    res.status(status).json({ error: err?.type === 'entity.parse.failed' ? 'Invalid JSON request.' : errorMessage(err) });
  });
  return app;
}
