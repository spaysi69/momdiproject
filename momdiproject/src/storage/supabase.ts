import { EnrichmentResponse } from '../core/types';

export class SupabaseStore {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly table = 'enrichment_profiles';

  constructor(
    url = process.env.SUPABASE_URL?.trim(),
    apiKey = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  ) {
    if (!url) throw new Error('Missing required secret SUPABASE_URL');
    if (!apiKey) throw new Error('Missing required secret SUPABASE_SECRET_KEY');
    this.baseUrl = url.replace(/\/$/, '') + '/rest/v1';
    this.apiKey = apiKey;
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    return {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async ping(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${this.table}?select=id&limit=1`, {
      method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Supabase unavailable: HTTP ${response.status}`);
  }

  async get(normalizedUrl: string): Promise<EnrichmentResponse | null> {
    const query = new URLSearchParams({ select: 'profile', normalized_url: `eq.${normalizedUrl}`, limit: '1' });
    const response = await fetch(`${this.baseUrl}/${this.table}?${query}`, {
      method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Supabase read failed: HTTP ${response.status}`);
    const rows = await response.json() as Array<{ profile?: EnrichmentResponse }>;
    return rows[0]?.profile ?? null;
  }

  async getPersonCompany(normalizedUrl: string, companyKey: string): Promise<EnrichmentResponse | null> {
    const query = new URLSearchParams({ select: 'profile', normalized_url: `eq.${normalizedUrl}`, company_key: `eq.${companyKey}`, limit: '1' });
    const response = await fetch(`${this.baseUrl}/enrichment_person_companies?${query}`, {
      method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      // The company-specific table was added after the original deployment.
      // Treat a missing table as a cache miss so older deployments still work.
      if (response.status === 404) return null;
      throw new Error(`Supabase company-cache read failed: HTTP ${response.status}`);
    }
    const rows = await response.json() as Array<{ profile?: EnrichmentResponse }>;
    return rows[0]?.profile ?? null;
  }

  async upsertPersonCompany(normalizedUrl: string, companyKey: string, profile: EnrichmentResponse): Promise<void> {
    const response = await fetch(`${this.baseUrl}/enrichment_person_companies?on_conflict=normalized_url,company_key`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ normalized_url: normalizedUrl, company_key: companyKey, profile, last_enriched_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      // Keep the main enrichment working even before the optional company-cache
      // migration has been applied. The legacy profile cache is still written.
      if (response.status === 404) return;
      const text = await response.text().catch(() => '');
      throw new Error(`Supabase company-cache write failed: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
  }

  async upsert(normalizedUrl: string, profile: EnrichmentResponse): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${this.table}?on_conflict=normalized_url`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ normalized_url: normalizedUrl, profile, last_enriched_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Supabase write failed: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
  }
}
