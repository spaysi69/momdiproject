export type FailureClass = 'AUTH' | 'CREDITS' | 'VALIDATION' | 'RATE_LIMIT' | 'TRANSIENT' | 'UNKNOWN';
export interface ClassifiedError { kind: FailureClass; retryable: boolean; retryAfterSeconds?: number; status?: number; message: string; }

export function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.ceil(value));
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

export function classifyProviderError(error: any): ClassifiedError {
  const status = error?.response?.status;
  const body = error?.response?.data;
  let bodyText = '';
  try { bodyText = typeof body === 'string' ? body : JSON.stringify(body ?? ''); } catch { bodyText = String(body ?? ''); }
  const retryAfter = parseRetryAfter(error?.response?.headers?.['retry-after']);
  if (status === 401 || status === 403) return { kind: 'AUTH', retryable: false, status, message: 'Provider authentication/authorization failed' };
  if ((status === 402 || status === 422) && /insufficient.?credits|credit|license|credits?\s+unavailable/i.test(bodyText)) return { kind: 'CREDITS', retryable: false, status, message: 'Provider credits or license are unavailable' };
  if (status === 400 || status === 404 || status === 409 || status === 422) return { kind: 'VALIDATION', retryable: false, status, message: 'Provider rejected the request' };
  if (status === 429) return { kind: 'RATE_LIMIT', retryable: true, retryAfterSeconds: retryAfter ?? 60, status, message: 'Provider rate limit reached' };
  const networkCodes = ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EPIPE', 'ECONNRESET'];
  if ((status && status >= 500) || networkCodes.includes(error?.code) || (error?.isAxiosError && !error?.response)) return { kind: 'TRANSIENT', retryable: true, status, message: 'Transient provider/network failure' };
  return { kind: 'UNKNOWN', retryable: false, status, message: error?.message ?? 'Unknown provider error' };
}
