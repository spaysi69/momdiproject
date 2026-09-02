export type ErrorKind = 'invalid_request' | 'auth' | 'forbidden' | 'not_found' | 'rate_limit' | 'provider_5xx' | 'network' | 'provider_business' | 'unknown';

export class AppError extends Error {
  constructor(public readonly kind: ErrorKind, message: string, public readonly retryable = false) { super(message); }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
