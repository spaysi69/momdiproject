export type RouteStatus = 'READY' | 'COOLDOWN' | 'DEGRADED' | 'AUTH_FAILED' | 'CREDITS_EXHAUSTED' | 'DISABLED';

export interface RouteRuntimeState {
  status: RouteStatus;
  consecutiveFailures: number;
  consecutiveRateLimits: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastStatusCode: number | null;
  observedEgressIp: string | null;
  lastIpCheckAt: number | null;
  lastLatencyMs: number | null;
}
