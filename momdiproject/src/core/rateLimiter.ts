import Redis from 'ioredis';

export type ReservationState = 'reserved' | 'cooldown' | 'rpm_exceeded' | 'rpd_exceeded';

export class QuotaExceededError extends Error {
  constructor(public readonly kind: 'rpm' | 'rpd' | 'cooldown', public readonly retryAfterSeconds?: number) {
    super(kind === 'cooldown' ? `Route cooling down${retryAfterSeconds ? ` for ${retryAfterSeconds}s` : ''}` : `Quota exceeded: ${kind}`);
    this.name = 'QuotaExceededError';
  }
}

export interface ReservationUsage { rpm: number; rpd: number; }

export class RateLimiter {
  private readonly redis: Redis;
  private readonly reserveScript = `
    local cooldown = redis.call('PTTL', KEYS[1])
    if cooldown and cooldown > 0 then
      return {0, -1, -1, cooldown}
    end

    local rpm = redis.call('INCR', KEYS[2])
    if rpm == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
    if tonumber(rpm) > tonumber(ARGV[1]) then
      redis.call('DECR', KEYS[2])
      return {2, rpm - 1, -1, 0}
    end

    local rpd = redis.call('INCR', KEYS[3])
    if rpd == 1 then redis.call('PEXPIRE', KEYS[3], ARGV[4]) end
    if tonumber(rpd) > tonumber(ARGV[2]) then
      redis.call('DECR', KEYS[2])
      redis.call('DECR', KEYS[3])
      return {3, -1, rpd - 1, 0}
    end

    return {1, rpm, rpd, 0}
  `;

  constructor(redis: Redis) { this.redis = redis; }

  private keys(id: string) {
    const now = Date.now();
    return {
      cooldown: `quota:${id}:cooldown`,
      rpm: `quota:${id}:rpm:${Math.floor(now / 60_000)}`,
      rpd: `quota:${id}:rpd:${Math.floor(now / 86_400_000)}`,
    };
  }

  async reserve(id: string, rpmLimit: number, rpdLimit: number): Promise<ReservationUsage> {
    const k = this.keys(id);
    const result = await this.redis.eval(
      this.reserveScript,
      3,
      k.cooldown,
      k.rpm,
      k.rpd,
      rpmLimit,
      rpdLimit,
      61_000,
      86_401_000,
    ) as [number, number, number, number];

    switch (result[0]) {
      case 1: return { rpm: result[1], rpd: result[2] };
      case 0: throw new QuotaExceededError('cooldown', Math.max(1, Math.ceil(result[3] / 1000)));
      case 2: throw new QuotaExceededError('rpm');
      case 3: throw new QuotaExceededError('rpd');
      default: throw new Error('Unknown quota reservation result');
    }
  }

  async setCooldown(id: string, seconds: number) {
    const safe = Math.max(1, Math.min(Math.ceil(seconds), 3600));
    await this.redis.set(this.keys(id).cooldown, '1', 'EX', safe);
  }

  async usage(id: string) {
    const k = this.keys(id);
    const [rpm, rpd] = await this.redis.mget(k.rpm, k.rpd);
    return { rpm: Number(rpm ?? 0), rpd: Number(rpd ?? 0) };
  }
}
