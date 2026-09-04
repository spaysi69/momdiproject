import Redis from 'ioredis';
import { ServiceConfig } from '../config/schema';
import { EnrichmentResponse } from '../core/types';
import { EnrichmentCache } from '../cache/enrichmentCache';
import { SupabaseStore } from '../storage/supabase';
import { normalizeLinkedInUrl, cacheKey } from '../utils/normalizeUrl';
import { SeamlessMcpClient, SeamlessMcpError } from '../mcp/seamlessMcp';
import { parseMcpContacts, parseResearchResponse, PersonSearchCandidate, searchPersonByLinkedIn } from './mcpPerson';
import { logger } from '../utils/logger';

function validLinkedIn(value: string): boolean {
  return /^https?:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9-_%]+\/?$/i.test(value);
}
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

export class EnrichmentService {
  private readonly cache: EnrichmentCache;
  private readonly store: SupabaseStore;
  private readonly mcp: SeamlessMcpClient;
  private readonly redis: Redis;

  constructor(private readonly config: ServiceConfig, redis: Redis) {
    this.redis = redis;
    this.cache = new EnrichmentCache(redis, config.cacheTtlSeconds);
    this.store = new SupabaseStore();
    const apiKey = process.env.SEAMLESS_MCP_API_KEY?.trim() || process.env.SEAMLESS_API_KEY_PRIMARY?.trim();
    if (!apiKey) throw new Error('Missing required secret SEAMLESS_MCP_API_KEY (or legacy SEAMLESS_API_KEY_PRIMARY fallback)');
    this.mcp = new SeamlessMcpClient(apiKey, process.env.SEAMLESS_MCP_BASE_URL?.trim() || 'https://mcp.seamless.ai/mcp', config.requestTimeoutMs);
  }

  private personSearchKey(url: string): string { return `person-search:${cacheKey(url)}`; }
  private researchJobKey(url: string): string { return `person-mcp-research:${cacheKey(url)}`; }

  private async saveSearch(url: string, payload: unknown): Promise<void> {
    await this.redis.set(this.personSearchKey(url), JSON.stringify(payload), 'EX', Math.max(300, this.config.cacheTtlSeconds));
  }
  private async loadSearch(url: string): Promise<any | null> {
    const raw = await this.redis.get(this.personSearchKey(url));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  private async saveResearchJob(url: string, payload: unknown): Promise<void> {
    await this.redis.set(this.researchJobKey(url), JSON.stringify(payload), 'EX', 1800);
  }
  private async loadResearchJob(url: string): Promise<any | null> {
    const raw = await this.redis.get(this.researchJobKey(url));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  private async clearResearchJob(url: string): Promise<void> { await this.redis.del(this.researchJobKey(url)); }

  async searchPerson(linkedinUrl: string): Promise<{ status: 'done'; person: any; companies: PersonSearchCandidate[]; cached: boolean; freeSearch: true }> {
    const normalized = normalizeLinkedInUrl(linkedinUrl);
    if (!validLinkedIn(normalized)) throw new Error('Enter a valid LinkedIn person URL, for example https://www.linkedin.com/in/example/');

    const stored = await this.loadSearch(normalized);
    if (stored) return { ...stored, cached: true, freeSearch: true };

    const matches = await searchPersonByLinkedIn(this.mcp, normalized);
    if (!matches.length) throw new Error('No Seamless contact record matched this LinkedIn profile. No research credit was consumed.');

    const companies = matches.map(x => ({
      ...x,
      current: x.current !== false,
    }));
    const primary = companies[0];
    const payload = {
      status: 'done' as const,
      person: {
        name: primary.fullName || [primary.firstName, primary.lastName].filter(Boolean).join(' ') || 'LinkedIn profile',
        linkedinUrl: primary.linkedinUrl || normalized,
        currentCompany: primary.company,
      },
      companies,
    };
    await this.saveSearch(normalized, payload);
    logger.info('person.search.free_mcp_success', { linkedinUrl: normalized, candidates: companies.length });
    return { ...payload, cached: false, freeSearch: true };
  }

  async startResearch(input: { linkedinUrl: string; searchResultId: string; personName?: string; companyName?: string }): Promise<any> {
    const normalized = normalizeLinkedInUrl(input.linkedinUrl);
    if (!validLinkedIn(normalized)) throw new Error('Enter a valid LinkedIn person URL, for example https://www.linkedin.com/in/example/');
    if (!input.searchResultId?.trim()) throw new Error('A Seamless searchResultId is required for research.');

    const existing = await this.loadResearchJob(normalized);
    if (existing && existing.searchResultId === input.searchResultId) return { status: 'processing', ...existing };

    const identityCacheKey = `research:${input.searchResultId}`;
    const cached = await this.cache.get(identityCacheKey);
    if (cached) return { status: 'done', data: cached, cached: true, searchResultId: input.searchResultId, creditsCharged: 0 };

    const acceptedRaw = await this.mcp.researchContacts({
      searchResultIds: [input.searchResultId],
      waitForResults: false,
    });
    const accepted = this.mcp.normalizeToolResult(acceptedRaw);
    const parsed = parseResearchResponse(accepted, normalized);
    const requestId = parsed.requestIds[0];
    if (!requestId) throw new Error('Seamless accepted the research call but did not return a requestId.');

    const job = {
      jobId: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      requestId,
      searchResultId: input.searchResultId,
      linkedinUrl: normalized,
      personName: input.personName || '',
      companyName: input.companyName || '',
      createdAt: Date.now(),
    };
    await this.saveResearchJob(normalized, job);
    logger.info('person.research.submitted', { jobId: job.jobId, requestId, searchResultId: input.searchResultId });
    return { status: 'processing', ...job, creditsCharged: 1 };
  }

  async pollResearch(linkedinUrl: string): Promise<any> {
    const normalized = normalizeLinkedInUrl(linkedinUrl);
    const job = await this.loadResearchJob(normalized);
    if (!job) {
      const search = await this.loadSearch(normalized);
      return search ? { status: 'idle', message: 'No active research job for this person.' } : { status: 'not_found' };
    }

    const raw = await this.mcp.pollContactResearch({ requestIds: [job.requestId] });
    const parsed = parseResearchResponse(this.mcp.normalizeToolResult(raw), normalized, job.requestId);
    const status = (parsed.status || 'researching').toLowerCase();
    if (['complete', 'completed', 'done', 'success', 'succeeded', 'finished'].includes(status)) {
      if (!parsed.data) throw new Error('Seamless completed the research job but returned no contact data.');
      await this.cache.set(`research:${job.searchResultId}`, parsed.data);
      await this.store.upsert(normalized, parsed.data);
      await this.cache.set(cacheKey(normalized), parsed.data);
      await this.clearResearchJob(normalized);
      return { status: 'done', data: parsed.data, cached: false, searchResultId: job.searchResultId, creditsCharged: 1 };
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      await this.clearResearchJob(normalized);
      throw new Error('Seamless contact research failed. No additional research request was submitted.');
    }
    return { status: 'processing', jobId: job.jobId, requestId: job.requestId, searchResultId: job.searchResultId };
  }

  async researchAndWait(input: { linkedinUrl: string; searchResultId: string; personName?: string; companyName?: string }): Promise<any> {
    const started = await this.startResearch(input);
    if (started.status === 'done') return started;
    for (let attempt = 0; attempt < Math.max(1, this.config.maxPolls); attempt += 1) {
      await sleep(this.config.pollIntervalMs);
      const result = await this.pollResearch(input.linkedinUrl);
      if (result.status !== 'processing') return result;
    }
    return { status: 'processing', message: 'Research is still running. Poll the research-status endpoint to continue.' };
  }

  async getCredits(): Promise<any> {
    const raw = await this.mcp.getCredits();
    const normalized = this.mcp.normalizeToolResult(raw);
    return parseCredits(normalized);
  }

  async status() {
    try {
      const credits = await this.getCredits();
      return { service: 'seamless-mcp', mcp: { status: 'READY', endpoint: process.env.SEAMLESS_MCP_BASE_URL?.trim() || 'https://mcp.seamless.ai/mcp' }, credits };
    } catch (error: any) {
      return { service: 'seamless-mcp', mcp: { status: 'ERROR', endpoint: process.env.SEAMLESS_MCP_BASE_URL?.trim() || 'https://mcp.seamless.ai/mcp', error: error?.message || String(error) }, credits: null };
    }
  }

  async ready() { await this.redis.ping(); }
}

function parseCredits(result: any): any {
  const objects: Record<string, any>[] = [];
  const collect = (v: unknown, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (Array.isArray(v)) { v.forEach(x => collect(x, depth + 1)); return; }
    if (typeof v !== 'object') return;
    const o = v as Record<string, any>;
    if (['remaining', 'creditsRemaining', 'credits', 'balance', 'available'].some(k => o[k] !== undefined)) objects.push(o);
    Object.values(o).forEach(x => collect(x, depth + 1));
  };
  result.structured.forEach((x: unknown) => collect(x));
  for (const text of result.text) {
    try { collect(JSON.parse(text)); } catch {}
  }
  const src = objects[0] || {};
  const pick = (...keys: string[]) => keys.map(k => src[k]).find(v => typeof v === 'number' || (typeof v === 'string' && v.trim()));
  return { remaining: pick('remaining', 'creditsRemaining', 'balance', 'available'), used: pick('used', 'creditsUsed'), total: pick('total', 'creditsLimit', 'limit'), raw: result.structured };
}
