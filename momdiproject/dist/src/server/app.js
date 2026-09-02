"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("../config");
const enrichment_1 = require("../http/enrichment");
const normalizeUrl_1 = require("../utils/normalizeUrl");
const logger_1 = require("../utils/logger");
const errors_1 = require("../http/errors");
const creditLedger_1 = require("../core/creditLedger");
function timingSafeEqualString(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length)
        return false;
    return node_crypto_1.default.timingSafeEqual(ab, bb);
}
async function createApp() {
    const config = (0, config_1.loadConfig)();
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!redisUrl)
        throw new Error('Missing required secret REDIS_URL');
    const redis = new ioredis_1.default(redisUrl, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: true,
        connectTimeout: 8000,
    });
    redis.on('error', err => logger_1.logger.error('redis.error', { message: err.message }));
    await redis.connect();
    await redis.ping();
    const enrichment = new enrichment_1.EnrichmentService(config, redis);
    const app = (0, express_1.default)();
    app.disable('x-powered-by');
    app.use(express_1.default.json({ limit: '32kb', strict: true }));
    const publicDir = node_path_1.default.resolve(__dirname, 'public');
    app.use(express_1.default.static(publicDir, { index: 'chatbox.html' }));
    app.get('/', (_req, res) => res.sendFile(node_path_1.default.join(publicDir, 'chatbox.html')));
    app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
    const expectedToken = process.env.APP_AUTH_TOKEN?.trim();
    const authenticate = (req, res, next) => {
        if (!expectedToken)
            return res.status(503).json({ error: 'Authentication is not configured' });
        const auth = req.header('Authorization') ?? '';
        if (!auth.startsWith('Bearer ') || !timingSafeEqualString(auth.slice(7), expectedToken))
            return res.status(401).json({ error: 'Unauthorized' });
        next();
    };
    app.get('/ready', async (_req, res) => {
        try {
            await redis.ping();
            await enrichment.ready();
            res.status(200).json({ status: 'ready' });
        }
        catch (error) {
            res.status(503).json({ status: 'not_ready', error: error?.message || 'dependencies unavailable' });
        }
    });
    app.get('/status', authenticate, async (_req, res, next) => {
        try {
            res.json(await enrichment.status());
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/v1/search/companies', authenticate, async (req, res, next) => {
        try {
            const query = req.body?.query;
            if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200)
                return res.status(400).json({ error: 'Enter a valid company name.' });
            res.json(await enrichment.searchCompanies(query, Math.min(Number(req.body?.limit) || 20, 50)));
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/v1/search/contacts', authenticate, async (req, res, next) => {
        try {
            const companyName = typeof req.body?.companyName === 'string' ? req.body.companyName : undefined;
            const companyDomain = typeof req.body?.companyDomain === 'string' ? req.body.companyDomain : undefined;
            if (!companyName && !companyDomain)
                return res.status(400).json({ error: 'Select a company first.' });
            res.json(await enrichment.searchContacts({ companyName, companyDomain, limit: Math.min(Number(req.body?.limit) || 20, 100), nextToken: typeof req.body?.nextToken === 'string' ? req.body.nextToken : null }));
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/v1/enrich-selected', authenticate, async (req, res, next) => {
        try {
            const ids = req.body?.searchResultIds;
            if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.length < 1))
                return res.status(400).json({ error: 'Select at least one contact.' });
            if (ids.length > 20)
                return res.status(400).json({ error: 'Select up to 20 contacts at a time.' });
            res.json(await enrichment.enrichManySearchResults(ids));
        }
        catch (error) {
            if (error instanceof creditLedger_1.ProviderCreditsExhaustedError)
                return res.status(402).json({ error: error.message });
            if (error?.name === 'QuotaExceededError')
                return res.status(429).json({ error: error.message });
            const classified = (0, errors_1.classifyProviderError)(error);
            if (classified.kind === 'AUTH')
                return res.status(502).json({ error: 'Provider authorization failed. Check the configured Seamless access.' });
            if (classified.kind === 'CREDITS')
                return res.status(402).json({ error: 'Provider credits are unavailable.' });
            if (classified.kind === 'RATE_LIMIT')
                return res.status(503).json({ error: 'Provider rate limit reached. Please retry later.' });
            next(error);
        }
    });
    app.post('/v1/enrich', authenticate, async (req, res) => {
        try {
            const raw = req.body?.linkedinUrl ?? req.body?.linkedin_url;
            if (typeof raw !== 'string' || raw.length > 2048)
                return res.status(400).json({ error: 'linkedinUrl must be a valid string' });
            const normalized = (0, normalizeUrl_1.normalizeLinkedInUrl)(raw);
            const result = await enrichment.enrich(normalized);
            res.json(result);
        }
        catch (error) {
            const classified = (0, errors_1.classifyProviderError)(error);
            logger_1.logger.warn('http.enrichment.failure', { kind: classified.kind, status: classified.status, message: classified.message });
            if (error?.name === 'QuotaExceededError')
                return res.status(429).json({ error: error.message });
            if (error instanceof creditLedger_1.ProviderCreditsExhaustedError)
                return res.status(402).json({ error: 'Provider credits are exhausted.' });
            if (error?.message === 'Seamless could not find this LinkedIn profile')
                return res.status(404).json({ error: error.message });
            if (classified.kind === 'AUTH')
                return res.status(502).json({ error: 'Provider authorization failed. Check the Seamless API key and Public API access.' });
            if (classified.kind === 'CREDITS')
                return res.status(402).json({ error: 'Provider credits or license are unavailable.' });
            if (classified.kind === 'RATE_LIMIT')
                return res.status(503).json({ error: 'Provider rate limit reached. Please retry later.' });
            if (classified.kind === 'VALIDATION')
                return res.status(422).json({ error: classified.message });
            if (error?.message?.startsWith('Supabase '))
                return res.status(503).json({ error: 'Persistent storage temporarily unavailable.' });
            if (classified.kind === 'TRANSIENT')
                return res.status(503).json({ error: 'Seamless is temporarily unavailable. Please retry.' });
            res.status(503).json({ error: 'Enrichment temporarily unavailable.' });
        }
    });
    app.use((err, _req, res, _next) => {
        logger_1.logger.error('http.unhandled_error', { message: err?.message });
        res.status(500).json({ error: 'Internal server error' });
    });
    return app;
}
