import { ServiceConfig } from '../config/schema';
import { SupabaseStore } from '../storage/supabase';
import { normalizeLinkedInUrl } from '../utils/normalizeUrl';
import { SeamlessMcpClient } from '../mcp/seamlessMcp';
import { parseResearchResponse, searchPersonByLinkedIn } from './mcpPerson';

const finished = (status?: string) => ['complete','completed','done','success','succeeded','finished'].includes((status || '').toLowerCase());
export class EnrichmentService {
  constructor(private readonly config: ServiceConfig,
    private readonly store = new SupabaseStore(),
    private readonly mcp = new SeamlessMcpClient(process.env.SEAMLESS_MCP_API_KEY?.trim() || process.env.SEAMLESS_API_KEY_PRIMARY?.trim() || '', config.mcpBaseUrl, Number(process.env.SEAMLESS_MCP_TIMEOUT_MS) || config.requestTimeoutMs)) {}

  async searchPerson(linkedinUrl: string): Promise<any> {
    const url = normalizeLinkedInUrl(linkedinUrl);
    // Supabase is the source of truth. Never replace a database outage with a provider call.
    let payload = await this.store.getSearch(url);
    const cached = !!payload;
    if (!payload) {
      const companies = await searchPersonByLinkedIn(this.mcp, url);
      payload = {person:{name:companies[0]?.fullName || 'LinkedIn profile',linkedinUrl:url},companies,searchedAt:new Date().toISOString()};
      await this.store.saveSearch(url, payload);
    }
    const jobs = await this.store.researchForPerson(url);
    const companies = payload.companies.map((c: any) => {
      const job = jobs.find((j:any)=>j.searchResultId === c.searchResultId);
      return {...c, research:job ? this.publicJob(job) : null};
    });
    return {...payload,companies,status:'done',cached,source:cached?'supabase':'seamless',freeSearch:true};
  }
  private publicJob(job:any):any {
    if (job.status === 'submitting' && Date.now()-job.createdAt > 120000) return {...job,status:'needs_review',message:'The previous submission could not be confirmed. Check Seamless before retrying; no new research has been submitted.'};
    return {...job,cached:job.status==='done'};
  }
  async startResearch(input:{linkedinUrl:string;searchResultId:string}):Promise<any> {
    const url = normalizeLinkedInUrl(input.linkedinUrl);
    const id = input.searchResultId?.trim();
    if (!id) throw new Error('Select a company record first.');
    const search = await this.store.getSearch(url);
    if (!search?.companies?.some((c:any)=>c.searchResultId===id)) throw new Error('This company record does not belong to the saved person search.');
    const existing = await this.store.getResearch(id);
    if (existing) return this.publicJob(existing);
    const job:any = {status:'submitting',searchResultId:id,linkedinUrl:url,createdAt:Date.now()};
    if (!await this.store.claimResearch(id,url,job)) {
      const winner = await this.store.getResearch(id);
      if (!winner) throw new Error('Cannot confirm research state. No new research was submitted.');
      return this.publicJob(winner);
    }
    let parsed;
    try {
      parsed = parseResearchResponse(this.mcp.normalizeToolResult(await this.mcp.researchContacts({searchResultIds:[id],waitForResults:false})),url);
    } catch (error) {
      await this.store.saveResearch(id,{...job,status:'needs_review',message:'Submission outcome is uncertain. Check Seamless; no automatic retry will be made.'});
      throw error;
    }
    if (finished(parsed.status) && parsed.data) Object.assign(job,{status:'done',data:parsed.data});
    else if (parsed.requestIds.length) Object.assign(job,{status:'processing',requestIds:parsed.requestIds});
    else Object.assign(job,{status:'needs_review',message:'Seamless returned no research request ID. Check Seamless before retrying.'});
    // If this write fails, the durable submitting marker still prevents a second paid call.
    await this.store.saveResearch(id,job);
    return job;
  }
  async pollResearch(id:string):Promise<any> {
    const job = await this.store.getResearch(id);
    if (!job) return {status:'not_found'};
    if (job.status !== 'processing') return this.publicJob(job);
    const parsed = parseResearchResponse(this.mcp.normalizeToolResult(await this.mcp.pollContactResearch({requestIds:job.requestIds})),job.linkedinUrl);
    if (finished(parsed.status)) {
      if (!parsed.data) return {...job,message:'Research finished but contact details were not returned. Check again without spending more credits.'};
      const done = {...job,status:'done',data:parsed.data};
      await this.store.saveResearch(id,done);
      return done;
    }
    if (['failed','error','cancelled','canceled'].includes((parsed.status||'').toLowerCase())) {
      const failed = {...job,status:'failed',message:'Seamless research failed. No additional research was submitted.'};
      await this.store.saveResearch(id,failed); return failed;
    }
    return job;
  }
  async ready() { await this.store.ready(); }
  async status() {
    const result:any={database:{status:'ERROR'},mcp:{status:'ERROR'},credits:null};
    try { await this.store.ready(); result.database={status:'READY'}; } catch(e:any) {result.database.error=e.message;}
    try {
      const raw=await this.mcp.getCredits(); result.credits=parseCredits(this.mcp.normalizeToolResult(raw));
      const tools=await this.mcp.listTools();
      const props=tools.find(t=>t.name==='search_contacts')?.inputSchema?.properties || {};
      result.mcp={status:'READY',linkedinSearch:Object.keys(props).some(k=>/^(liProfileUrls?|linkedinUrls?)$/i.test(k))};
    } catch(e:any) { result.mcp.error=e.message; }
    return result;
  }
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
