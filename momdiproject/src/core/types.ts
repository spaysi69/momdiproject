export type RouteStatus = 'READY' | 'COOLDOWN' | 'DEGRADED' | 'AUTH_FAILED' | 'CREDITS_EXHAUSTED' | 'DISABLED';

export interface RouteState {
  id: string;
  status: RouteStatus;
  rpmLimit: number;
  rpmRemaining: number;
  rpdLimit: number;
  rpdRemaining: number;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  consecutive429s: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastStatusCode: number | null;
  latencyMs: number | null;
}

export interface EnrichmentResponse {
  id?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  linkedinUrl: string;
}
