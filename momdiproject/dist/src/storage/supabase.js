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
}
exports.SupabaseStore = SupabaseStore;
