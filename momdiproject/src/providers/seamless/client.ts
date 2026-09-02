import axios, { AxiosError } from 'axios';
import { EnrichmentResponseSchema, type EnrichmentResponse } from '../../domain/enrichment.js';
import { AppError } from '../../utils/errors.js';

export interface ProviderClient {
  enrich(linkedinUrl: string, signal?: AbortSignal): Promise<EnrichmentResponse>;
}

export interface EgressIpProbeResult {
  ip: string | null;
  checkedAt: number;
}

export class EgressIpProbe {
  private cached: EgressIpProbeResult = { ip: null, checkedAt: 0 };

  constructor(private readonly url: string, private readonly timeoutMs = 2500, private readonly cacheTtlMs = 60_000) {}

  async get(): Promise<EgressIpProbeResult> {
    const now = Date.now();
    if (this.cached.ip && now - this.cached.checkedAt < this.cacheTtlMs) return this.cached;
    try {
      const response = await axios.get(this.url, { timeout: this.timeoutMs, validateStatus: status => status >= 200 && status < 300 });
      const payload = response.data as unknown;
      const ip = typeof payload === 'string'
        ? payload.trim()
        : typeof payload === 'object' && payload !== null && 'ip' in payload && typeof payload.ip === 'string'
          ? payload.ip.trim()
          : null;
      if (!ip) throw new Error('IP probe did not return an IP address');
      this.cached = { ip, checkedAt: now };
      return this.cached;
    } catch {
      return this.cached.ip ? this.cached : { ip: null, checkedAt: now };
    }
  }
}

function retryAfterSeconds(headers: Record<string, unknown>): number | null {
  const raw = headers['retry-after'];
  if (typeof raw === 'number') return Math.max(0, raw);
  if (typeof raw !== 'string') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  return null;
}

export class SeamlessClient implements ProviderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 30_000,
    private readonly ipProbe?: EgressIpProbe,
  ) {}

  async enrich(linkedinUrl: string, signal?: AbortSignal): Promise<EnrichmentResponse> {
    try {
      const response = await axios.post(
        `${this.baseUrl.replace(/\/$/, '')}/v1/enrich`,
        { linkedin_url: linkedinUrl },
        {
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: this.timeoutMs,
          signal,
        },
      );
      return EnrichmentResponseSchema.parse(response.data);
    } catch (error) {
      if (!(error instanceof AxiosError)) throw new AppError('unknown', 'Provider request failed', false);
      const status = error.response?.status;
      const body = error.response?.data as { code?: string; message?: string; error?: string } | undefined;
      const message = [body?.message ?? body?.error ?? error.message, body?.code].filter(Boolean).join(' | ');
      if (status === 400) throw new AppError('invalid_request', message, false);
      if (status === 401) throw new AppError('auth', message, false);
      if (status === 403) throw new AppError('forbidden', message, false);
      if (status === 404) throw new AppError('not_found', message, false);
      if (status === 422) throw new AppError('provider_business', message, false);
      if (status === 429) {
        const retryAfter = retryAfterSeconds((error.response?.headers ?? {}) as Record<string, unknown>);
        throw new AppError('rate_limit', `${message}${retryAfter === null ? '' : `; retry_after=${retryAfter}`}`, true);
      }
      if (status !== undefined && status >= 500) throw new AppError('provider_5xx', message, true);
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') throw new AppError('network', message, true);
      throw new AppError('unknown', message, false);
    }
  }

  async getObservedEgressIp(): Promise<EgressIpProbeResult> {
    return this.ipProbe?.get() ?? { ip: null, checkedAt: Date.now() };
  }
}
