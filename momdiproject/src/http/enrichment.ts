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
  private readonly store: SupabaseStore | null;
  private readonly mcp: SeamlessMcpClient;
  private readonly redis: Redis;

  constructor(private readonly config: ServiceConfig, redis: Redis) {
    this.redis = redis;
    this.cache = new EnrichmentCache(redis, config.cacheTtlSeconds);
    this.store = process.env.SUPABASE_URL ? new SupabaseStore() : null;
    const apiKey = process.env.SEAMLESS_MCP_API_KEY?.trim() || process.env.SEAMLESS_API_KEY_PRIMARY?.trim();
    if (!apiKey) throw new Error('Missing required secret SEAMLESS_MCP_API_KEY (or legacy SEAMLESS_API_KEY_PRIMARY fallback)');
    this.mcp = new SeamlessMcpClient(apiKey, process.env.SEAMLESS_MCP_BASE_URL?.trim() || 'https://mcp.seamless.ai/mcp', Number(process.env.SEAMLESS_MCP_TIMEOUT_MS) || config.requestTimeoutMs);
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
      current: x.current,
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

  async searchContacts(filters: Record<string, unknown>): Promise<any> {
    const result = this.mcp.normalizeToolResult(await this.mcp.searchContacts(filters));
    const contacts = parseMcpContacts(result, '').slice(0, Number(filters.limit) || 20);
    for (const contact of contacts) await this.redis.set(`candidate:${contact.searchResultId}`, JSON.stringify(contact), 'EX', 86400);
    return { contacts, freeSearch: true, count: contacts.length };
  }

  async startResearch(input: { linkedinUrl: string; searchResultId: string; personName?: string; companyName?: string }): Promise<any> {
    const id = input.searchResultId.trim();
    if (!id) throw new Error('A Seamless searchResultId is required.');
    const key = `research-job:${id}`;
    const cached = await this.redis.get(`research:${id}`);
    if (cached) return {status: 'done', data: JSON.parse(cached), cached: true, searchResultId: id};
    const existing = await this.redis.get(key);
    if (existing) return JSON.parse(existing);
    const locked = await this.redis.set(`research-lock:${id}`, '1', 'EX', 120, 'NX');
    if (!locked) return {status: 'processing', searchResultId: id};
    try {
      const recheck = await this.redis.get(key);
      if (recheck) return JSON.parse(recheck);
      // Persist BEFORE the paid call. An ambiguous timeout must never trigger automatic resubmission.
      const job: any = {status: 'submitting', searchResultId: id, linkedinUrl: input.linkedinUrl, createdAt: Date.now()};
      await this.redis.set(key, JSON.stringify(job));
      const parsed = parseResearchResponse(this.mcp.normalizeToolResult(await this.mcp.researchContacts({searchResultIds:[id], waitForResults:false})), input.linkedinUrl);
      if (parsed.data && /complete|done|success|finished/i.test(parsed.status || '')) {
        await this.redis.set(`research:${id}`, JSON.stringify(parsed.data), 'EX', this.config.cacheTtlSeconds);
        await this.redis.set(key, JSON.stringify({...job, status:'done', data:parsed.data}));
        return {...job, status:'done', data:parsed.data};
      }
      if (!parsed.requestIds.length) throw new Error('Provider returned no research request ID. Check Seamless before retrying.');
      Object.assign(job, {status:'processing', requestIds:parsed.requestIds});
      await this.redis.set(key, JSON.stringify(job));
      return job;
    } catch (error) {
      await this.redis.set(key, JSON.stringify({status:'needs_review', searchResultId:id, message:'Submission outcome is uncertain. Check Seamless before starting another research request.'}));
      throw error;
    } finally { await this.redis.del(`research-lock:${id}`); }
  }

  async pollResearch(identity: string): Promise<any> {
    const jobRaw = await this.redis.get(`research-job:${identity}`);
    if (!jobRaw) return {status:'not_found'};
    const job = JSON.parse(jobRaw);
    if (job.status !== 'processing') return job;
    const parsed = parseResearchResponse(this.mcp.normalizeToolResult(await this.mcp.pollContactResearch({requestIds:job.requestIds})), job.linkedinUrl || '');
    const status = (parsed.status || '').toLowerCase();
    if (['complete','completed','done','success','succeeded','finished'].includes(status)) {
      if (!parsed.data) return {...job, message:'Provider completed research but returned no contact details.'};
      await this.redis.set(`research:${identity}`, JSON.stringify(parsed.data), 'EX', this.config.cacheTtlSeconds);
      const completed: any = {...job, status:'done', data:parsed.data};
      await this.redis.set(`research-job:${identity}`, JSON.stringify(completed));
      if (this.store && parsed.data.linkedinUrl) {
        try { await this.store.upsert(parsed.data.linkedinUrl, parsed.data); }
        catch { completed.storageWarning = 'Research is saved in Redis; Supabase sync failed.'; }
      }
      return completed;
    }
    if (['failed','error','cancelled','canceled'].includes(status)) {
      const failed = {...job, status:'failed', message:'Provider research failed. No new research was submitted.'};
      await this.redis.set(`research-job:${identity}`, JSON.stringify(failed));
      return failed;
    }
    return job;
  }

  async researchAndWait(input: { linkedinUrl: string; searchResultId: string; personName?: string; companyName?: string }): Promise<any> {
    const started = await this.startResearch(input);
    if (started.status === 'done') return started;
    for (let attempt = 0; attempt < Math.max(1, this.config.maxPolls); attempt += 1) {
      await sleep(this.config.pollIntervalMs);
      const result = await this.pollResearch(input.searchResultId);
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
