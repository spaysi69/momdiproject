import Redis from 'ioredis';
import { ServiceConfig, RouteConfig } from '../config/schema';
import { RateLimiter, QuotaExceededError } from '../core/rateLimiter';
import { RouteStateMachine } from '../core/stateMachine';
import { EnrichmentResponse } from '../core/types';
import { classifyProviderError } from './errors';
import { ContactSearchResult, SeamlessClient } from './client';
import { normalizeLinkedInUrl, cacheKey } from '../utils/normalizeUrl';
import { EnrichmentCache } from '../cache/enrichmentCache';
import { logger } from '../utils/logger';
import { SupabaseStore } from '../storage/supabase';
import { CreditLedger, ProviderCreditsExhaustedError } from '../core/creditLedger';

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function normalizeCompanyName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function extractCareerCompanies(raw: Record<string, unknown>, profile: EnrichmentResponse) {
  const found = new Map<string, { name:string; title?:string; startDate?:string; endDate?:string; current?:boolean; domain?:string; linkedinUrl?:string }>();
  const candidateArrays: unknown[] = [];
  const visit=(value:unknown,depth=0):void=>{if(depth>6||value==null)return;if(Array.isArray(value)){value.forEach(v=>visit(v,depth+1));return}if(typeof value!=='object')return;for(const [key,child] of Object.entries(value as Record<string,unknown>)){if(Array.isArray(child)&&/(employment|experience|career|work.?history|job.?history|positions?|jobs?)/i.test(key))candidateArrays.push(child);if(typeof child==='object')visit(child,depth+1)}};
  visit(raw);
  for(const arr of candidateArrays){for(const item of arr as unknown[]){if(!item||typeof item!=='object')continue;const obj=item as Record<string,unknown>;const companyObj=[obj.company,obj.employer,obj.organization,obj.companyInfo].find(v=>v&&typeof v==='object') as Record<string,unknown>|undefined;const name=text(obj.companyName)??text(obj.company)??text(obj.employerName)??text(obj.employer)??text(obj.organizationName)??text(companyObj?.name)??text(companyObj?.companyName);if(!name)continue;const key=normalizeCompanyName(name);if(!key||key==='unemployed'||key==='student')continue;const entry={name,title:text(obj.title)??text(obj.jobTitle)??text(obj.position)??text(obj.role),startDate:text(obj.startDate)??text(obj.start)??text(obj.from),endDate:text(obj.endDate)??text(obj.end)??text(obj.to),current:Boolean(obj.current??obj.isCurrent??obj.currentRole)||(!text(obj.endDate)&&!text(obj.end)),domain:text(obj.domain)??text(companyObj?.domain),linkedinUrl:text(obj.companyLinkedInUrl)??text(obj.companyLIProfileUrl)??text(obj.linkedinUrl)??text(companyObj?.linkedinUrl)};const existing=found.get(key);found.set(key,existing?{...existing,title:existing.title??entry.title,startDate:existing.startDate??entry.startDate,endDate:existing.endDate??entry.endDate,current:existing.current||entry.current,domain:existing.domain??entry.domain,linkedinUrl:existing.linkedinUrl??entry.linkedinUrl}:entry)}}
  if(profile.company){const key=normalizeCompanyName(profile.company);const existing=found.get(key);found.set(key,{name:existing?.name??profile.company,title:existing?.title??profile.title,current:true,domain:existing?.domain??profile.companyDomain,linkedinUrl:existing?.linkedinUrl??profile.companyLinkedInUrl})}
  return [...found.values()].sort((a,b)=>Number(Boolean(b.current))-Number(Boolean(a.current)));
}

type RouteRuntime={cfg:RouteConfig;client:SeamlessClient;machine:RouteStateMachine};

export class EnrichmentService {
  private readonly limiter: RateLimiter;
  private readonly cache: EnrichmentCache;
  private readonly store: SupabaseStore;
  private readonly redis: Redis;
  private readonly credits: CreditLedger;
  private readonly routes: RouteRuntime[];

  constructor(private readonly config: ServiceConfig, redis: Redis) {
    this.redis=redis; this.credits=new CreditLedger(redis); this.limiter=new RateLimiter(redis); this.cache=new EnrichmentCache(redis,config.cacheTtlSeconds); this.store=new SupabaseStore();
    const routeConfigs=config.routes ?? [{ id:'primary', apiKeyEnv:config.apiKeyEnv, credits:config.credits.starting, limits:config.limits, priority:100, egressGroup:'egress-1' }];
    this.routes=routeConfigs.map((cfg: RouteConfig)=>{const apiKey=process.env[cfg.apiKeyEnv]?.trim();if(!apiKey)throw new Error(`Missing required secret ${cfg.apiKeyEnv}`);const proxyUrl=cfg.proxyUrlEnv?process.env[cfg.proxyUrlEnv]?.trim():undefined;const client=new SeamlessClient({baseUrl:config.providerBaseUrl,apiKey,timeoutMs:config.requestTimeoutMs,pollIntervalMs:config.pollIntervalMs,maxPolls:config.maxPolls,proxyUrl});const machine=new RouteStateMachine(cfg.id,cfg.limits.rpm,cfg.limits.rpd);void this.credits.ensureInitialized(cfg.id,this.startingCredits(cfg));return {cfg,client,machine};}).sort((a: RouteRuntime,b: RouteRuntime)=>b.cfg.priority-a.cfg.priority);
  }

  private startingCredits(route:RouteRuntime['cfg']):number { const env=process.env[`SEAMLESS_API_CREDITS_${route.id.toUpperCase()}`]?.trim(); if(env && /^\d+$/.test(env)) return Number(env); return route.credits; }
  private candidateRoutes():RouteRuntime[]{return this.routes.slice().sort((a,b)=>{const sa=a.machine.snapshot(),sb=b.machine.snapshot();const rank=(s:ReturnType<RouteStateMachine['snapshot']>,r:RouteConfig)=>s.status==='READY'?0:s.status==='DEGRADED'?1:2;return rank(sa,a.cfg)-rank(sb,b.cfg)||b.cfg.priority-a.cfg.priority;});}
  private async usableRoutes():Promise<RouteRuntime[]>{const out:RouteRuntime[]=[];for(const r of this.candidateRoutes()){const state=r.machine.snapshot();if(['AUTH_FAILED','CREDITS_EXHAUSTED','DISABLED'].includes(state.status))continue;if(state.status==='COOLDOWN'&&state.cooldownUntil&&state.cooldownUntil>Date.now())continue;if(state.status==='COOLDOWN'&&state.cooldownUntil&&state.cooldownUntil<=Date.now())r.machine.onCooldownExpired();const credits=await this.credits.remaining(r.cfg.id,this.startingCredits(r.cfg));if(credits<1)continue;try{const usage=await this.limiter.usage(r.cfg.id);if(usage.rpm>=r.cfg.limits.rpm||usage.rpd>=r.cfg.limits.rpd)continue;out.push(r);}catch(error){if(error instanceof QuotaExceededError)continue;throw error}}return out;}
  private async reserveRoute(route:RouteRuntime):Promise<{rpm:number;rpd:number}>{const usage=await this.limiter.reserve(route.cfg.id,route.cfg.limits.rpm,route.cfg.limits.rpd);const remaining=await this.credits.remaining(route.cfg.id,this.startingCredits(route.cfg));if(remaining<1)throw new ProviderCreditsExhaustedError();return usage;}
  private async acquireLock(key:string,token:string,ttlSeconds=90):Promise<boolean>{return (await this.redis.set(`enrich:lock:${key}`,token,'EX',ttlSeconds,'NX'))==='OK';}
  private async releaseLock(key:string,token:string):Promise<void>{await this.redis.eval(RELEASE_LOCK_SCRIPT,1,`enrich:lock:${key}`,token);}
  private async waitForExistingEnrichment(key:string,normalizedUrl:string):Promise<EnrichmentResponse|null>{for(let i=0;i<120;i+=1){await new Promise<void>(r=>setTimeout(r,500));const persisted=await this.store.get(normalizedUrl);if(persisted)return persisted;const redisCached=await this.cache.get(key);if(redisCached)return redisCached;if(!(await this.redis.exists(`enrich:lock:${key}`)))return null;}return null;}

  async inspectPersonCompanies(linkedinUrl:string){
    const normalized=normalizeLinkedInUrl(linkedinUrl);
    if(!/^https?:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9-_%]+\/?$/i.test(normalized)) throw new Error('Enter a valid LinkedIn person URL, for example https://www.linkedin.com/in/example/');
    const enriched=await this.enrich(normalized);
    let companies;
    try {
      companies=extractCareerCompanies(enriched.data.raw??{},enriched.data);
    } catch (error:any) {
      logger.warn('person_lookup.company_history_parse_failed',{message:error?.message||'unknown'});
      companies=enriched.data.company?[{name:enriched.data.company,title:enriched.data.title,current:true,domain:enriched.data.companyDomain,linkedinUrl:enriched.data.companyLinkedInUrl}]:[];
    }
    return {person:{name:enriched.data.fullName,linkedinUrl:enriched.data.linkedinUrl||normalized,currentCompany:enriched.data.company},companies,cached:enriched.cached};
  }

  async searchContacts(input:{companyName:string;companyDomain?:string;limit?:number;nextToken?:string|null}):Promise<{contacts:ContactSearchResult[];total?:number;nextToken?:string|null}>{throw new Error('Company-wide contact search is not part of the person-first workflow.');}

  async enrichPersonForCompany(input:{linkedinUrl:string;personName:string;companyName:string;title?:string}){const linkedinUrl=normalizeLinkedInUrl(input.linkedinUrl);const identity=`person-company:${cacheKey(linkedinUrl)}:${normalizeCompanyName(input.companyName)}`;const cached=await this.cache.get(identity);if(cached){const total=await this.totalCredits();return {data:cached,cached:true,source:'provider' as const,attempts:0,creditsRemaining:total};}
    let lastError:unknown;
    for(const route of await this.usableRoutes()){for(let attempt=1;attempt<=this.config.maxAttempts;attempt+=1){try{await this.reserveRoute(route);const started=Date.now();const data=await route.client.researchContactByIdentity({contactName:input.personName,companyName:input.companyName,title:input.title,linkedinUrl},async()=>{await this.credits.consume(route.cfg.id,1);});const creditsRemaining=await this.totalCredits();await this.cache.set(identity,data);await this.saveByLinkedInIfPresent(data);const usage=await this.limiter.usage(route.cfg.id);route.machine.onSuccess(Date.now()-started,usage.rpm,usage.rpd);logger.info('enrichment.person_company.success',{routeId:route.cfg.id,attempt,egressGroup:route.cfg.egressGroup,durationMs:Date.now()-started,creditsRemaining,companyName:input.companyName});return {data,cached:false,source:'provider' as const,attempts:attempt,creditsRemaining};}catch(error){lastError=error;const classified=classifyProviderError(error);if(classified.kind==='AUTH')route.machine.onAuthFailure(classified.status??401);else if(classified.kind==='CREDITS')route.machine.onCreditsExhausted(classified.status??422);else if(classified.kind==='RATE_LIMIT')route.machine.on429(classified.retryAfterSeconds??60);else if(classified.kind==='TRANSIENT')route.machine.onTransientFailure(classified.status??null);if(error instanceof ProviderCreditsExhaustedError||classified.kind==='AUTH'||classified.kind==='CREDITS')break;if(classified.kind!=='TRANSIENT'&&classified.kind!=='RATE_LIMIT')throw error;if(attempt>=this.config.maxAttempts)break;await new Promise(r=>setTimeout(r,Math.min(8000,500*(2**(attempt-1)))+Math.floor(Math.random()*250)));}}}
    if(lastError instanceof ProviderCreditsExhaustedError)throw lastError;throw lastError??new Error('No configured provider route has available capacity.');}

  async enrichSearchResult(_searchResultId:string){throw new Error('Search-result enrichment is disabled in person-first mode.');}
  async enrichManySearchResults(_ids:string[]){throw new Error('Search-result enrichment is disabled in person-first mode.');}

  private async saveByLinkedInIfPresent(data:EnrichmentResponse){if(!data.linkedinUrl)return;const key=cacheKey(data.linkedinUrl);await this.store.upsert(data.linkedinUrl,data);await this.cache.set(key,data);}

  async enrich(normalizedUrl:string):Promise<{data:EnrichmentResponse;cached:boolean;source:'supabase'|'redis'|'provider';attempts:number}>{const key=cacheKey(normalizedUrl);const persisted=await this.store.get(normalizedUrl);if(persisted){await this.cache.set(key,persisted);return {data:persisted,cached:true,source:'supabase',attempts:0};}const redisCached=await this.cache.get(key);if(redisCached)return {data:redisCached,cached:true,source:'redis',attempts:0};const token=`${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;let owns=await this.acquireLock(key,token);if(!owns){const existing=await this.waitForExistingEnrichment(key,normalizedUrl);if(existing)return {data:existing,cached:true,source:'supabase',attempts:0};owns=await this.acquireLock(key,token);if(!owns)throw new Error('Another enrichment is still in progress; please retry.');}
    try{const second=await this.store.get(normalizedUrl);if(second){await this.cache.set(key,second);return {data:second,cached:true,source:'supabase',attempts:0};}let lastError:unknown;for(const route of await this.usableRoutes()){for(let attempt=1;attempt<=this.config.maxAttempts;attempt+=1){try{await this.reserveRoute(route);const started=Date.now();const data=await route.client.researchContactByLinkedInUrl(normalizedUrl,false);const creditsRemaining=await this.credits.consume(route.cfg.id,1);await this.store.upsert(normalizedUrl,data);await this.cache.set(key,data);const usage=await this.limiter.usage(route.cfg.id);route.machine.onSuccess(Date.now()-started,usage.rpm,usage.rpd);logger.info('enrichment.success',{routeId:route.cfg.id,attempt,egressGroup:route.cfg.egressGroup,durationMs:Date.now()-started,creditsRemaining});return {data,cached:false,source:'provider',attempts:attempt};}catch(error){lastError=error;const classified=classifyProviderError(error);if(classified.kind==='AUTH')route.machine.onAuthFailure(classified.status??401);else if(classified.kind==='CREDITS')route.machine.onCreditsExhausted(classified.status??422);else if(classified.kind==='RATE_LIMIT')route.machine.on429(classified.retryAfterSeconds??60);else if(classified.kind==='TRANSIENT')route.machine.onTransientFailure(classified.status??null);if(classified.kind==='AUTH'||classified.kind==='CREDITS')break;if(classified.kind!=='TRANSIENT'&&classified.kind!=='RATE_LIMIT')throw error;if(attempt>=this.config.maxAttempts)break;await new Promise(r=>setTimeout(r,Math.min(8000,500*(2**(attempt-1)))+Math.floor(Math.random()*250)));}}}throw lastError??new Error('No configured provider route has available capacity.');}finally{if(owns)await this.releaseLock(key,token);}}

  private async totalCredits(){let total=0;for(const r of this.routes)total+=await this.credits.remaining(r.cfg.id,this.startingCredits(r.cfg));return total;}

  async status(){const routes=[];for(const r of this.routes){const route=r.machine.snapshot();const usage=await this.limiter.usage(r.cfg.id);const creditsRemaining=await this.credits.remaining(r.cfg.id,this.startingCredits(r.cfg));routes.push({id:r.cfg.id,status:route.status,rpmLimit:r.cfg.limits.rpm,rpmRemaining:Math.max(0,r.cfg.limits.rpm-usage.rpm),rpdLimit:r.cfg.limits.rpd,rpdRemaining:Math.max(0,r.cfg.limits.rpd-usage.rpd),creditsRemaining,creditsLimit:this.startingCredits(r.cfg),egressGroup:r.cfg.egressGroup});}const creditsRemaining=routes.reduce((sum,r)=>sum+r.creditsRemaining,0);const creditsLimit=routes.reduce((sum,r)=>sum+r.creditsLimit,0);return {routes,creditsRemaining,creditsLimit,route:routes[0],usage:{rpm:routes[0]?.rpmLimit-(routes[0]?.rpmRemaining??0),rpd:routes[0]?.rpdLimit-(routes[0]?.rpdRemaining??0)}};}
  async ready(){await this.redis.ping();}
}
