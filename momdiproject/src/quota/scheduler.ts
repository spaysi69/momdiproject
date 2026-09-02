import type Redis from 'ioredis';
import type { RouteConfig } from '../config/schema.js';
import { reserveQuota, setCooldown } from './reservation.js';
import type { RouteRuntimeState, RouteStatus } from '../domain/routes/state.js';

const KEY = (id: string) => `route:state:${id}`;
const DEFAULT: RouteRuntimeState = {
  status: 'READY',
  consecutiveFailures: 0,
  consecutiveRateLimits: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  lastStatusCode: null,
  observedEgressIp: null,
  lastIpCheckAt: null,
  lastLatencyMs: null,
};

export class RouteScheduler {
  constructor(private readonly redis: Redis, private readonly routes: RouteConfig[]) {}

  private async getState(routeId: string): Promise<RouteRuntimeState> {
    const raw = await this.redis.hgetall(KEY(routeId));
    if (!Object.keys(raw).length) return { ...DEFAULT };
    return {
      status: (raw.status as RouteStatus) ?? 'READY',
      consecutiveFailures: Number(raw.consecutiveFailures ?? 0),
      consecutiveRateLimits: Number(raw.consecutiveRateLimits ?? 0),
      lastFailureAt: raw.lastFailureAt ? Number(raw.lastFailureAt) : null,
      lastSuccessAt: raw.lastSuccessAt ? Number(raw.lastSuccessAt) : null,
      lastStatusCode: raw.lastStatusCode ? Number(raw.lastStatusCode) : null,
      observedEgressIp: raw.observedEgressIp || null,
      lastIpCheckAt: raw.lastIpCheckAt ? Number(raw.lastIpCheckAt) : null,
      lastLatencyMs: raw.lastLatencyMs ? Number(raw.lastLatencyMs) : null,
    };
  }

  private async setState(routeId: string, state: RouteRuntimeState): Promise<void> {
    await this.redis.hset(KEY(routeId), {
      status: state.status,
      consecutiveFailures: state.consecutiveFailures,
      consecutiveRateLimits: state.consecutiveRateLimits,
      lastFailureAt: state.lastFailureAt ?? '',
      lastSuccessAt: state.lastSuccessAt ?? '',
      lastStatusCode: state.lastStatusCode ?? '',
      observedEgressIp: state.observedEgressIp ?? '',
      lastIpCheckAt: state.lastIpCheckAt ?? '',
      lastLatencyMs: state.lastLatencyMs ?? '',
    });
  }

  async acquire(): Promise<RouteConfig | null> {
    const states = await Promise.all(this.routes.map(async route => [route, await this.getState(route.id)] as const));
    states.sort((a, b) => {
      const rank = (s: RouteRuntimeState) => ({ READY: 0, DEGRADED: 1, COOLDOWN: 2, AUTH_FAILED: 3, CREDITS_EXHAUSTED: 4, DISABLED: 5 } as Record<RouteStatus, number>)[s.status];
      return (rank(a[1]) - rank(b[1])) || (b[0].priority - a[0].priority) || (a[1].consecutiveFailures - b[1].consecutiveFailures);
    });
    for (const [route, state] of states) {
      if (!route.enabled || state.status === 'AUTH_FAILED' || state.status === 'CREDITS_EXHAUSTED' || state.status === 'DISABLED') continue;
      const reservation = await reserveQuota(this.redis, route);
      if (reservation.granted) return route;
    }
    return null;
  }

  async markRateLimited(routeId: string, retryAfterSeconds: number): Promise<void> {
    const state = await this.getState(routeId);
    state.consecutiveRateLimits += 1;
    state.consecutiveFailures += 1;
    state.lastFailureAt = Date.now();
    state.status = 'COOLDOWN';
    state.lastStatusCode = 429;
    await Promise.all([setCooldown(this.redis, routeId, retryAfterSeconds || Math.min(60, 2 ** Math.min(6, state.consecutiveRateLimits))), this.setState(routeId, state)]);
  }

  async markAuthFailed(routeId: string): Promise<void> { const s = await this.getState(routeId); s.status = 'AUTH_FAILED'; s.lastFailureAt = Date.now(); s.lastStatusCode = 401; await this.setState(routeId, s); }
  async markCreditsExhausted(routeId: string): Promise<void> { const s = await this.getState(routeId); s.status = 'CREDITS_EXHAUSTED'; s.lastFailureAt = Date.now(); s.lastStatusCode = 422; await this.setState(routeId, s); }
  async markDisabled(routeId: string): Promise<void> { const s = await this.getState(routeId); s.status = 'DISABLED'; await this.setState(routeId, s); }
  async reset(routeId: string): Promise<void> { const s = await this.getState(routeId); s.status = 'READY'; s.consecutiveFailures = 0; s.consecutiveRateLimits = 0; s.lastStatusCode = null; await this.setState(routeId, s); }

  async markSuccess(routeId: string, latencyMs: number): Promise<void> {
    const s = await this.getState(routeId);
    s.status = 'READY';
    s.consecutiveFailures = 0;
    s.consecutiveRateLimits = 0;
    s.lastSuccessAt = Date.now();
    s.lastStatusCode = 200;
    s.lastLatencyMs = Math.max(0, Math.round(latencyMs));
    await this.setState(routeId, s);
  }

  async markTransientFailure(routeId: string, statusCode = 503): Promise<void> {
    const s = await this.getState(routeId); s.consecutiveFailures += 1; s.lastFailureAt = Date.now(); s.lastStatusCode = statusCode; s.status = s.consecutiveFailures >= 3 ? 'DEGRADED' : 'READY'; await this.setState(routeId, s);
  }

  async updateObservedEgressIp(routeId: string, ip: string | null): Promise<void> {
    const state = await this.getState(routeId);
    state.observedEgressIp = ip;
    state.lastIpCheckAt = Date.now();
    await this.setState(routeId, state);
  }

  async getStatus() {
    return Promise.all(this.routes.map(async route => {
      const state = await this.getState(route.id);
      const [rpmRaw, rpdRaw, cooldownTtl] = await Promise.all([
        this.redis.get(`quota:${route.id}:rpm`),
        this.redis.get(`quota:${route.id}:rpd`),
        this.redis.ttl(`quota:${route.id}:cooldown`),
      ]);
      return {
        routeId: route.id,
        credentialConfigured: Boolean(process.env[route.apiKeyEnv]?.trim()),
        status: route.enabled ? state.status : 'DISABLED' as const,
        ...state,
        limits: route.limits,
        usage: { rpm: Number(rpmRaw ?? 0), rpd: Number(rpdRaw ?? 0) },
        cooldownSeconds: Math.max(0, cooldownTtl),
        priority: route.priority,
        enabled: route.enabled,
        networkLabel: route.networkLabel ?? null,
        expectedEgressIp: route.expectedEgressIp ?? null,
        ipMatch: route.expectedEgressIp && state.observedEgressIp ? route.expectedEgressIp === state.observedEgressIp : null,
      };
    }));
  }

}
