import type Redis from 'ioredis';
import type { RouteConfig } from '../config/schema.js';

const RESERVE_LUA = `
local cooldown = redis.call('GET', KEYS[3])
if cooldown then return {0, -2, -2, tonumber(redis.call('TTL', KEYS[3]))} end
local rpm = tonumber(redis.call('GET', KEYS[1]) or '0')
local rpd = tonumber(redis.call('GET', KEYS[2]) or '0')
local rpmLimit = tonumber(ARGV[1])
local rpdLimit = tonumber(ARGV[2])
if rpm >= rpmLimit then return {0, rpm, rpd, 0} end
if rpd >= rpdLimit then return {0, rpm, rpd, 0} end
rpm = redis.call('INCR', KEYS[1])
if rpm == 1 then redis.call('EXPIRE', KEYS[1], 60) end
rpd = redis.call('INCR', KEYS[2])
if rpd == 1 then redis.call('EXPIRE', KEYS[2], 86400) end
return {1, rpm, rpd, 0}
`;

export interface ReservationResult { granted: boolean; rpm: number; rpd: number; cooldownSeconds: number; }

export async function reserveQuota(redis: Redis, route: RouteConfig): Promise<ReservationResult> {
  const keys = [`quota:${route.id}:rpm`, `quota:${route.id}:rpd`, `quota:${route.id}:cooldown`];
  const result = await redis.eval(RESERVE_LUA, keys.length, ...keys, String(route.limits.rpm), String(route.limits.rpd)) as number[];
  return { granted: result[0] === 1, rpm: result[1] ?? 0, rpd: result[2] ?? 0, cooldownSeconds: Math.max(0, result[3] ?? 0) };
}

export async function setCooldown(redis: Redis, routeId: string, seconds: number): Promise<void> {
  await redis.set(`quota:${routeId}:cooldown`, '1', 'EX', Math.max(1, Math.ceil(seconds)));
}
