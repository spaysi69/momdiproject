import fs from 'node:fs';
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../config';
import { EnrichmentService } from '../http/enrichment';
import { SeamlessRestError } from '../seamless/restClient';
import { logger } from '../utils/logger';

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function errorMessage(error: any): string { return error?.message || String(error); }

export async function createApp(providedService?: any) {
  const config = loadConfig();
  let service = providedService;
  const enrichment = () => service ??= new EnrichmentService(config);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '32kb', strict: true }));
  const publicDir = path.resolve(__dirname, 'public');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); next(); });
  app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
  app.get('/app.css', (_req,res) => res.sendFile(path.join(publicDir, 'app.css')));
  app.get('/login.js', (_req,res) => res.sendFile(path.join(publicDir, 'login.js')));
  const buildInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../BUILD_INFO.json'), 'utf8'));
  app.get('/health', (_req,res) => res.json({ status: 'ok', version: buildInfo.version, buildId: buildInfo.buildId, architecture: 'direct-linkedin-rest' }));

  const expectedToken = process.env.APP_AUTH_TOKEN?.trim();
  const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!expectedToken) return res.status(503).json({ error: 'Authentication is not configured' });
    const auth = req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !timingSafeEqualString(auth.slice(7), expectedToken)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };

  app.post('/auth/login', authenticate, (_req,res) => res.json({ authenticated: true }));
  app.get(['/workspace', '/chatbox.html'], authenticate, (_req,res) => res.sendFile(path.join(publicDir, 'chatbox.html')));
  app.get('/app.js', authenticate, (_req,res) => res.sendFile(path.join(publicDir, 'app.js')));

  app.get('/ready', authenticate, async (_req, res) => {
    try { await enrichment().ready(); res.status(200).json({ status: 'ready' }); }
    catch (error: any) { res.status(503).json({ status: 'not_ready', error: errorMessage(error) }); }
  });
  app.get('/status', authenticate, async (_req, res) => res.json(await enrichment().status()));

  app.post('/v1/person/lookup', authenticate, async (req, res) => {
    try {
      const linkedinUrl = typeof req.body?.linkedinUrl === 'string' ? req.body.linkedinUrl.trim() : '';
      if (!linkedinUrl) return res.status(400).json({ error: 'Enter a LinkedIn person URL.' });
      return res.json(await enrichment().lookup(linkedinUrl));
    } catch (error: any) {
      if (/LinkedIn|Invalid URL|profile URL/i.test(errorMessage(error))) return res.status(422).json({ error: errorMessage(error) });
      logger.error('http.person.lookup', { error: errorMessage(error), stack: error?.stack });
      return res.status(502).json({ error: errorMessage(error) });
    }
  });

  app.post('/v1/person/research', authenticate, async (req, res) => {
    try {
      const linkedinUrl = typeof req.body?.linkedinUrl === 'string' ? req.body.linkedinUrl.trim() : '';
      if (!linkedinUrl) return res.status(400).json({ error: 'linkedinUrl is required.' });
      const result = await enrichment().startResearch(linkedinUrl);
      return res.status(result.status === 'processing' || result.status === 'submitting' ? 202 : 200).json(result);
    } catch (error: any) {
      const msg = errorMessage(error);
      if (error instanceof SeamlessRestError) {
        if (error.code === 'insufficientCredits') return res.status(402).json({ error: msg, code: error.code });
        if (error.code === 'missingLicense') return res.status(403).json({ error: msg, code: error.code });
        if (error.status === 401 || error.status === 403) return res.status(502).json({ error: msg, code: error.code });
        if (error.status === 429) return res.status(503).json({ error: msg, code: error.code });
        if (error.status === 422) return res.status(422).json({ error: msg, code: error.code });
      }
      logger.error('http.person.research', { error: msg, stack: error?.stack });
      return res.status(502).json({ error: msg });
    }
  });

  app.post('/v1/person/research/status', authenticate, async (req, res) => {
    try {
      const linkedinUrl = typeof req.body?.linkedinUrl === 'string' ? req.body.linkedinUrl.trim() : '';
      if (!linkedinUrl) return res.status(400).json({ error: 'linkedinUrl is required.' });
      const result = await enrichment().pollResearch(linkedinUrl);
      if (result.status === 'not_found') return res.status(404).json({ error: 'No research job was found for this LinkedIn URL.' });
      return res.status(result.status === 'processing' || result.status === 'submitting' ? 202 : 200).json(result);
    } catch (error: any) {
      const msg = errorMessage(error);
      if (error instanceof SeamlessRestError && error.status === 429) return res.status(503).json({ error: msg, code: error.code });
      return res.status(502).json({ error: msg });
    }
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('http.unhandled_error', { message: errorMessage(err), stack: err?.stack });
    res.status(err?.type === 'entity.parse.failed' ? 400 : 502).json({ error: err?.type === 'entity.parse.failed' ? 'Invalid JSON request.' : errorMessage(err) });
  });
  return app;
}
