import { RouteState, RouteStatus } from './types';

export class RouteStateMachine {
  private readonly state: RouteState;
  constructor(id: string, rpmLimit: number, rpdLimit: number) {
    this.state = {
      id, status: 'READY', rpmLimit, rpmRemaining: rpmLimit, rpdLimit, rpdRemaining: rpdLimit,
      cooldownUntil: null, consecutiveFailures: 0, consecutive429s: 0,
      lastSuccessAt: null, lastFailureAt: null, lastStatusCode: null, latencyMs: null,
    };
  }
  snapshot(): RouteState { return { ...this.state }; }
  onSuccess(latencyMs: number, rpm: number, rpd: number) {
    this.state.status = 'READY'; this.state.consecutiveFailures = 0; this.state.consecutive429s = 0;
    this.state.lastSuccessAt = Date.now(); this.state.lastStatusCode = 200; this.state.latencyMs = latencyMs;
    this.state.rpmRemaining = Math.max(0, this.state.rpmLimit - rpm); this.state.rpdRemaining = Math.max(0, this.state.rpdLimit - rpd);
  }
  on429(cooldownSeconds: number) {
    this.state.status = 'COOLDOWN'; this.state.consecutive429s += 1; this.state.lastFailureAt = Date.now(); this.state.lastStatusCode = 429;
    this.state.cooldownUntil = Date.now() + cooldownSeconds * 1000;
  }
  onAuthFailure(code: number) { this.state.status = 'AUTH_FAILED'; this.state.lastFailureAt = Date.now(); this.state.lastStatusCode = code; }
  onCreditsExhausted(code: number) { this.state.status = 'CREDITS_EXHAUSTED'; this.state.lastFailureAt = Date.now(); this.state.lastStatusCode = code; }
  onTransientFailure(code: number | null) {
    this.state.status = this.state.consecutiveFailures >= 2 ? 'DEGRADED' : 'READY';
    this.state.consecutiveFailures += 1; this.state.lastFailureAt = Date.now(); this.state.lastStatusCode = code;
  }
}
