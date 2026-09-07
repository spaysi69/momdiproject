import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../config';
import { EnrichmentService } from '../http/enrichment';
import { logger } from '../utils/logger';

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function errorMessage(error: any): string { return error?.message || String(error); }

export async function createApp(providedService?: EnrichmentService) {
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
  app.get('/health', (_req,res) => res.json({status:'ok',version:'29.1.0'}));

  const expectedToken = process.env.APP_AUTH_TOKEN?.trim();
  const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!expectedToken) return res.status(503).json({ error: 'Authentication is not configured' });
    const auth = req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !timingSafeEqualString(auth.slice(7), expectedToken)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };

  app.post('/auth/login', authenticate, (_req,res) => res.json({authenticated:true}));
  app.get(['/workspace', '/chatbox.html'], authenticate, (_req,res) => res.sendFile(path.join(publicDir, 'chatbox.html')));
  app.get('/app.js', authenticate, (_req,res) => res.sendFile(path.join(publicDir, 'app.js')));

  app.get('/ready', authenticate, async (_req, res) => {
    try { await enrichment().ready(); res.status(200).json({ status: 'ready' }); }
    catch (error: any) { res.status(503).json({ status: 'not_ready', error: errorMessage(error) }); }
  });
  app.get('/status', authenticate, async (_req, res) => res.json(await enrichment().status()));

  app.get('/diagnostics/search-schema', authenticate, async (_req,res,next) => {
    try { res.json(await enrichment().searchDiagnostic()); } catch(error) { next(error); }
  });

  app.post('/v1/person/search', authenticate, async (req, res) => {
    try {
      const linkedinUrl = typeof req.body?.linkedinUrl === 'string' ? req.body.linkedinUrl.trim() : '';
      if (!linkedinUrl) return res.status(400).json({ error: 'Enter a LinkedIn person URL.' });
      return res.json(await enrichment().searchPerson(linkedinUrl));
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
      if (!linkedinUrl || !searchResultId) return res.status(400).json({ error: 'searchResultId is required.' });
      const result = await enrichment().startResearch({ linkedinUrl, searchResultId });
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
      if (typeof req.body?.searchResultId !== 'string' || !req.body.searchResultId.trim()) return res.status(400).json({ error: 'searchResultId is required.' });
      const result = await enrichment().pollResearch(req.body.searchResultId.trim());
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
