import Redis from 'ioredis';

export class ProviderCreditsExhaustedError extends Error {
  constructor(message = 'Provider credits are exhausted') {
    super(message);
    this.name = 'ProviderCreditsExhaustedError';
  }
}

export class CreditLedger {
  constructor(private readonly redis: Redis, private readonly keyPrefix = 'provider:credits') {}

  private key(routeId: string) { return `${this.keyPrefix}:${routeId}:remaining`; }

  async ensureInitialized(routeId: string, startingCredits: number): Promise<number> {
    const key = this.key(routeId);
    await this.redis.set(key, Math.max(0, Math.floor(startingCredits)), 'NX');
    const value = await this.redis.get(key);
    return Number(value ?? 0);
  }

  async remaining(routeId: string, startingCredits: number): Promise<number> {
    return this.ensureInitialized(routeId, startingCredits);
  }

  async consume(routeId: string, amount = 1): Promise<number> {
    const key = this.key(routeId);
    const script = `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      local amount = tonumber(ARGV[1])
      if current < amount then return -1 end
      return redis.call('DECRBY', KEYS[1], amount)
    `;
    const result = Number(await this.redis.eval(script, 1, key, amount));
    if (result < 0) throw new ProviderCreditsExhaustedError();
    return result;
  }
}
