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
  private async request(table: string, query: Record<string,string>, method = 'GET', body?: unknown, prefer?: string): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/${table}?${new URLSearchParams(query)}`, {
      method, headers: this.headers(prefer ? {Prefer:prefer} : {}),
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Supabase ${table} ${method} failed (${response.status}). Apply supabase/schema.sql and check your server credentials.`);
    return response;
  }
  async ready(): Promise<void> {
    await this.request('person_searches', {select:'normalized_url',limit:'0'});
    await this.request('contact_research', {select:'search_result_id',limit:'0'});
  }
  async getSearch(url: string): Promise<any | null> {
    const response = await this.request('person_searches', {select:'payload',normalized_url:`eq.${url}`,limit:'1'});
    return ((await response.json()) as any[])[0]?.payload ?? null;
  }
  async saveSearch(url: string, payload: unknown): Promise<void> {
    await this.request('person_searches', {on_conflict:'normalized_url'}, 'POST',
      {normalized_url:url,payload,updated_at:new Date().toISOString()}, 'resolution=merge-duplicates,return=minimal');
  }
  async getResearch(id: string): Promise<any | null> {
    const response = await this.request('contact_research', {select:'payload',search_result_id:`eq.${id}`,limit:'1'});
    return ((await response.json()) as any[])[0]?.payload ?? null;
  }
  async researchForPerson(url: string): Promise<any[]> {
    const response = await this.request('contact_research', {select:'payload',normalized_url:`eq.${url}`});
    return ((await response.json()) as any[]).map(row=>row.payload);
  }
  async claimResearch(id: string, url: string, payload: unknown): Promise<boolean> {
    // Database UNIQUE key arbitrates concurrent requests across every app instance.
    const response = await this.request('contact_research', {on_conflict:'search_result_id'}, 'POST',
      {search_result_id:id,normalized_url:url,payload}, 'resolution=ignore-duplicates,return=representation');
    return ((await response.json()) as any[]).length === 1;
  }
  async saveResearch(id: string, payload: unknown): Promise<void> {
    const response = await this.request('contact_research', {search_result_id:`eq.${id}`}, 'PATCH',
      {payload,updated_at:new Date().toISOString()}, 'return=representation');
    if (!((await response.json()) as any[]).length) throw new Error('Research record missing; no new research was submitted.');
  }

}
