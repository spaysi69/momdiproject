"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreditLedger = exports.ProviderCreditsExhaustedError = void 0;
class ProviderCreditsExhaustedError extends Error {
    constructor(message = 'Provider credits are exhausted') {
        super(message);
        this.name = 'ProviderCreditsExhaustedError';
    }
}
exports.ProviderCreditsExhaustedError = ProviderCreditsExhaustedError;
class CreditLedger {
    redis;
    keyPrefix;
    constructor(redis, keyPrefix = 'provider:credits') {
        this.redis = redis;
        this.keyPrefix = keyPrefix;
    }
    key(routeId) { return `${this.keyPrefix}:${routeId}:remaining`; }
    async ensureInitialized(routeId, startingCredits) {
        const key = this.key(routeId);
        await this.redis.set(key, Math.max(0, Math.floor(startingCredits)), 'NX');
        const value = await this.redis.get(key);
        return Number(value ?? 0);
    }
    async remaining(routeId, startingCredits) {
        return this.ensureInitialized(routeId, startingCredits);
    }
    async consume(routeId, amount = 1) {
        const key = this.key(routeId);
        const script = `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      local amount = tonumber(ARGV[1])
      if current < amount then return -1 end
      return redis.call('DECRBY', KEYS[1], amount)
    `;
        const result = Number(await this.redis.eval(script, 1, key, amount));
        if (result < 0)
            throw new ProviderCreditsExhaustedError();
        return result;
    }
}
exports.CreditLedger = CreditLedger;
