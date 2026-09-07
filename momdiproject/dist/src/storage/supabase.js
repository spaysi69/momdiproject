"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupabaseStore = void 0;
class SupabaseStore {
    baseUrl;
    apiKey;
    table = 'enrichment_profiles';
    constructor(url = process.env.SUPABASE_URL?.trim(), apiKey = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
        if (!url)
            throw new Error('Missing required secret SUPABASE_URL');
        if (!apiKey)
            throw new Error('Missing required secret SUPABASE_SECRET_KEY');
        this.baseUrl = url.replace(/\/$/, '') + '/rest/v1';
        this.apiKey = apiKey;
    }
    headers(extra = {}) {
        return {
            apikey: this.apiKey,
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...extra,
        };
    }
    async ping() {
        const response = await fetch(`${this.baseUrl}/${this.table}?select=id&limit=1`, {
            method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok)
            throw new Error(`Supabase unavailable: HTTP ${response.status}`);
    }
    async get(normalizedUrl) {
        const query = new URLSearchParams({ select: 'profile', normalized_url: `eq.${normalizedUrl}`, limit: '1' });
        const response = await fetch(`${this.baseUrl}/${this.table}?${query}`, {
            method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok)
            throw new Error(`Supabase read failed: HTTP ${response.status}`);
        const rows = await response.json();
        return rows[0]?.profile ?? null;
    }
    async upsert(normalizedUrl, profile) {
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
    async request(table, query, method = 'GET', body, prefer) {
        const response = await fetch(`${this.baseUrl}/${table}?${new URLSearchParams(query)}`, {
            method, headers: this.headers(prefer ? { Prefer: prefer } : {}),
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
            throw new Error(`Supabase ${table} ${method} failed (${response.status}). Apply supabase/schema.sql and check your server credentials.`);
        return response;
    }
    async ready() {
        await this.request('person_searches', { select: 'normalized_url', limit: '0' });
        await this.request('contact_research', { select: 'search_result_id', limit: '0' });
    }
    async getSearch(url) {
        const response = await this.request('person_searches', { select: 'payload', normalized_url: `eq.${url}`, limit: '1' });
        return (await response.json())[0]?.payload ?? null;
    }
    async saveSearch(url, payload) {
        await this.request('person_searches', { on_conflict: 'normalized_url' }, 'POST', { normalized_url: url, payload, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
    }
    async getResearch(id) {
        const response = await this.request('contact_research', { select: 'payload', search_result_id: `eq.${id}`, limit: '1' });
        return (await response.json())[0]?.payload ?? null;
    }
    async researchForPerson(url) {
        const response = await this.request('contact_research', { select: 'payload', normalized_url: `eq.${url}` });
        return (await response.json()).map(row => row.payload);
    }
    async claimResearch(id, url, payload) {
        // Database UNIQUE key arbitrates concurrent requests across every app instance.
        const response = await this.request('contact_research', { on_conflict: 'search_result_id' }, 'POST', { search_result_id: id, normalized_url: url, payload }, 'resolution=ignore-duplicates,return=representation');
        return (await response.json()).length === 1;
    }
    async saveResearch(id, payload) {
        const response = await this.request('contact_research', { search_result_id: `eq.${id}` }, 'PATCH', { payload, updated_at: new Date().toISOString() }, 'return=representation');
        if (!(await response.json()).length)
            throw new Error('Research record missing; no new research was submitted.');
    }
}
exports.SupabaseStore = SupabaseStore;
