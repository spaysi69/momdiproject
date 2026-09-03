import Redis from 'ioredis';

export class ProviderCreditsExhaustedError extends Error {
  constructor(message = 'Provider credits are exhausted') {
    super(message);
    this.name = 'ProviderCreditsExhaustedError';
  }
}

/**
 * Stores the last provider-reported credit balance per route.
 * The documented source of truth is Seamless' X-PublicAPI-Credits response header.
 */
export class CreditLedger {
  private readonly namespace = 'provider:credits:v2';

  constructor(private readonly redis: Redis) {}

  private key(routeId: string) { return `${this.namespace}:${routeId}:remaining`; }
  private updatedKey(routeId: string) { return `${this.namespace}:${routeId}:updatedAt`; }

  async setProviderRemaining(routeId: string, remaining: number): Promise<number> {
    const value = Math.max(0, Math.floor(remaining));
    await this.redis.set(this.key(routeId), String(value));
    await this.redis.set(this.updatedKey(routeId), String(Date.now()));
    return value;
  }

  async lastUpdatedAt(routeId: string): Promise<number | null> {
    const value = await this.redis.get(this.updatedKey(routeId));
    if (value === null || !/^\d+$/.test(value.trim())) return null;
    return Number(value);
  }

  async knownRemaining(routeId: string): Promise<number | null> {
    const value = await this.redis.get(this.key(routeId));
    if (value === null || value.trim() === '' || !/^\d+$/.test(value.trim())) return null;
    return Number(value);
  }

  /** Used only as a backwards-compatible fallback when a provider response did not include the credit header. */
  async decrementFallback(routeId: string): Promise<number> {
    const key = this.key(routeId);
    const script = `
      local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
      if current < 0 then return -2 end
      if current < 1 then return -1 end
      return redis.call('DECRBY', KEYS[1], 1)
    `;
    const result = Number(await this.redis.eval(script, 1, key));
    if (result === -1) throw new ProviderCreditsExhaustedError();
    return result === -2 ? 0 : result;
  }
}
