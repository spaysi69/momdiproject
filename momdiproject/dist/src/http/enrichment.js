"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnrichmentService = void 0;
const rateLimiter_1 = require("../core/rateLimiter");
const stateMachine_1 = require("../core/stateMachine");
const errors_1 = require("./errors");
const client_1 = require("./client");
const enrichmentCache_1 = require("../cache/enrichmentCache");
const normalizeUrl_1 = require("../utils/normalizeUrl");
const logger_1 = require("../utils/logger");
const supabase_1 = require("../storage/supabase");
const creditLedger_1 = require("../core/creditLedger");
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;
class EnrichmentService {
    config;
    limiter;
    cache;
    machine;
    client;
    store;
    routeId = 'primary';
    redis;
    credits;
    constructor(config, redis) {
        this.config = config;
        const apiKey = process.env[config.apiKeyEnv]?.trim();
        if (!apiKey)
            throw new Error(`Missing required secret ${config.apiKeyEnv}`);
        this.redis = redis;
        this.credits = new creditLedger_1.CreditLedger(redis);
        this.limiter = new rateLimiter_1.RateLimiter(redis);
        this.cache = new enrichmentCache_1.EnrichmentCache(redis, config.cacheTtlSeconds);
        this.machine = new stateMachine_1.RouteStateMachine(this.routeId, config.limits.rpm, config.limits.rpd);
        this.client = new client_1.SeamlessClient({
            baseUrl: config.providerBaseUrl,
            apiKey,
            timeoutMs: config.requestTimeoutMs,
            pollIntervalMs: config.pollIntervalMs,
            maxPolls: config.maxPolls,
        });
        this.store = new supabase_1.SupabaseStore();
        void this.credits.ensureInitialized(this.routeId, this.config.credits.starting);
    }
    async acquireLock(key, token, ttlSeconds = 90) {
        return (await this.redis.set(`enrich:lock:${key}`, token, 'EX', ttlSeconds, 'NX')) === 'OK';
    }
    async releaseLock(key, token) {
        await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, `enrich:lock:${key}`, token);
    }
    async waitForExistingEnrichment(key, normalizedUrl) {
        for (let i = 0; i < 120; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const persisted = await this.store.get(normalizedUrl);
            if (persisted)
                return persisted;
            const redisCached = await this.cache.get(key);
            if (redisCached)
                return redisCached;
            if (!(await this.redis.exists(`enrich:lock:${key}`)))
                return null;
        }
        return null;
    }
    async searchCompanies(query, limit = 20) {
        if (!query.trim())
            throw new Error('Enter a company name to search.');
        await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
        return this.client.searchCompanies(query.trim(), limit);
    }
    async searchContacts(input) {
        if (!input.companyName?.trim() && !input.companyDomain?.trim())
            throw new Error('Select a company first.');
        await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
        return this.client.searchContacts(input);
    }
    async enrichSearchResult(searchResultId) {
        const current = await this.credits.remaining(this.routeId, this.config.credits.starting);
        if (current < 1)
            throw new creditLedger_1.ProviderCreditsExhaustedError();
        for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
            try {
                await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
                const started = Date.now();
                const data = await this.client.researchContactBySearchResultId(searchResultId, false, async () => { await this.credits.consume(this.routeId, 1); });
                const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
                await this.saveByLinkedInIfPresent(data);
                const usage = await this.limiter.usage(this.routeId);
                this.machine.onSuccess(Date.now() - started, usage.rpm, usage.rpd);
                logger_1.logger.info('enrichment.success', { routeId: this.routeId, attempt, durationMs: Date.now() - started, creditsRemaining });
                return { data, cached: false, source: 'provider', attempts: attempt, creditsRemaining };
            }
            catch (error) {
                const classified = (0, errors_1.classifyProviderError)(error);
                await this.machine.recordFailure(classified.status ?? null, classified.kind);
                logger_1.logger.warn('enrichment.failure', { routeId: this.routeId, attempt, kind: classified.kind, status: classified.status, message: classified.message });
                if (error instanceof creditLedger_1.ProviderCreditsExhaustedError)
                    throw error;
                if (classified.kind !== 'TRANSIENT' && classified.kind !== 'RATE_LIMIT')
                    throw error;
                if (attempt >= this.config.maxAttempts)
                    throw error;
                const delay = Math.min(8000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw new Error('Enrichment failed');
    }
    async enrichManySearchResults(searchResultIds) {
        const unique = [...new Set(searchResultIds.filter(Boolean))];
        const remaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
        if (unique.length === 0)
            throw new Error('Select at least one contact.');
        if (unique.length > remaining)
            throw new creditLedger_1.ProviderCreditsExhaustedError(`Only ${remaining} research credit${remaining === 1 ? '' : 's'} remaining; you selected ${unique.length} contact${unique.length === 1 ? '' : 's'}.`);
        const results = [];
        for (const id of unique) {
            try {
                const result = await this.enrichSearchResult(id);
                results.push({ searchResultId: id, data: result.data, creditsRemaining: result.creditsRemaining });
            }
            catch (error) {
                const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
                results.push({ searchResultId: id, error: error?.message || 'Research failed', creditsRemaining });
            }
        }
        return { results, creditsRemaining: await this.credits.remaining(this.routeId, this.config.credits.starting) };
    }
    async saveByLinkedInIfPresent(data) {
        if (!data.linkedinUrl)
            return;
        const key = (0, normalizeUrl_1.cacheKey)(data.linkedinUrl);
        await this.store.upsert(data.linkedinUrl, data);
        await this.cache.set(key, data);
    }
    async enrich(normalizedUrl) {
        const key = (0, normalizeUrl_1.cacheKey)(normalizedUrl);
        const persisted = await this.store.get(normalizedUrl);
        if (persisted) {
            await this.cache.set(key, persisted);
            return { data: persisted, cached: true, source: 'supabase', attempts: 0 };
        }
        const redisCached = await this.cache.get(key);
        if (redisCached)
            return { data: redisCached, cached: true, source: 'redis', attempts: 0 };
        const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        let ownsLock = await this.acquireLock(key, lockToken);
        if (!ownsLock) {
            const existing = await this.waitForExistingEnrichment(key, normalizedUrl);
            if (existing) {
                await this.cache.set(key, existing);
                return { data: existing, cached: true, source: 'supabase', attempts: 0 };
            }
            ownsLock = await this.acquireLock(key, lockToken);
            if (!ownsLock)
                throw new Error('Another enrichment is still in progress; please retry.');
        }
        try {
            const secondPersisted = await this.store.get(normalizedUrl);
            if (secondPersisted) {
                await this.cache.set(key, secondPersisted);
                return { data: secondPersisted, cached: true, source: 'supabase', attempts: 0 };
            }
            for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
                try {
                    await this.limiter.reserve(this.routeId, this.config.limits.rpm, this.config.limits.rpd);
                    const started = Date.now();
                    const current = await this.credits.remaining(this.routeId, this.config.credits.starting);
                    if (current < 1)
                        throw new creditLedger_1.ProviderCreditsExhaustedError();
                    const data = await this.client.researchContactByLinkedInUrl(normalizedUrl, false);
                    const creditsRemaining = await this.credits.consume(this.routeId, 1);
                    await this.store.upsert(normalizedUrl, data);
                    await this.cache.set(key, data);
                    const usage = await this.limiter.usage(this.routeId);
                    this.machine.onSuccess(Date.now() - started, usage.rpm, usage.rpd);
                    logger_1.logger.info('enrichment.success', { routeId: this.routeId, attempt, durationMs: Date.now() - started, creditsRemaining });
                    return { data, cached: false, source: 'provider', attempts: attempt };
                }
                catch (error) {
                    const classified = (0, errors_1.classifyProviderError)(error);
                    if (error instanceof creditLedger_1.ProviderCreditsExhaustedError)
                        throw error;
                    if (classified.kind !== 'TRANSIENT' && classified.kind !== 'RATE_LIMIT')
                        throw error;
                    if (attempt >= this.config.maxAttempts)
                        throw error;
                    const delay = Math.min(8000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
            throw new Error('Enrichment failed');
        }
        finally {
            if (ownsLock)
                await this.releaseLock(key, lockToken);
        }
    }
    async status() {
        const route = await this.machine.snapshot();
        const usage = await this.limiter.usage(this.routeId);
        const creditsRemaining = await this.credits.remaining(this.routeId, this.config.credits.starting);
        return { route, usage, creditsRemaining, creditsLimit: this.config.credits.starting };
    }
    async ready() { await this.redis.ping(); }
}
exports.EnrichmentService = EnrichmentService;
