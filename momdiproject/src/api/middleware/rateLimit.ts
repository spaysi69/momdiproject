import type Redis from 'ioredis';
import type { RequestHandler } from 'express';

const LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return current
`;

export function redisFixedWindowLimit(redis: Redis, maxRequests: number, windowSeconds: number): RequestHandler {
  return async (req, res, next) => {
    try {
      const identity = req.header('authorization') ? 'auth' : (req.ip ?? 'unknown');
      const key = `api-rate:${identity}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
      const count = Number(await redis.eval(LUA, 1, key, String(windowSeconds)));
      if (count > maxRequests) return res.status(429).json({ error: 'Too many requests' });
      next();
    } catch (error) { next(error); }
  };
}
