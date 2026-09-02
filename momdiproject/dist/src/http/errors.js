"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRetryAfter = parseRetryAfter;
exports.classifyProviderError = classifyProviderError;
function parseRetryAfter(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.max(0, Math.ceil(value));
    if (typeof value !== 'string' || !value.trim())
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds))
        return Math.max(0, Math.ceil(seconds));
    const date = Date.parse(value);
    if (!Number.isNaN(date))
        return Math.max(0, Math.ceil((date - Date.now()) / 1000));
    return undefined;
}
function classifyProviderError(error) {
    const status = error?.response?.status;
    const body = error?.response?.data;
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    const retryAfter = parseRetryAfter(error?.response?.headers?.['retry-after']);
    if (status === 401 || status === 403)
        return { kind: 'AUTH', retryable: false, status, message: 'Provider authentication/authorization failed' };
    if (status === 422 && /insufficient.?credits|credit|license/i.test(bodyText))
        return { kind: 'CREDITS', retryable: false, status, message: 'Provider credits or license are unavailable' };
    if (status === 400 || status === 404 || status === 409 || status === 422)
        return { kind: 'VALIDATION', retryable: false, status, message: 'Provider rejected the request' };
    if (status === 429)
        return { kind: 'RATE_LIMIT', retryable: true, retryAfterSeconds: retryAfter ?? 60, status, message: 'Provider rate limit reached' };
    if ((status && status >= 500) || ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNREFUSED'].includes(error?.code))
        return { kind: 'TRANSIENT', retryable: true, status, message: 'Transient provider/network failure' };
    return { kind: 'UNKNOWN', retryable: false, status, message: error?.message ?? 'Unknown provider error' };
}
