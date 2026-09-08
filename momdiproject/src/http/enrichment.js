'use strict';
const crypto=require('node:crypto');
const {SeamlessRestError}=require('../seamless/restClient');
const {SeamlessRoutePool}=require('../seamless/routePool');
const {SupabaseStore}=require('../storage/supabase');
const {normalizeLinkedInUrl}=require('../utils/normalizeUrl');
const {DiagnosticJournal}=require('../diagnostics/journal');

function str(...values){for(const value of values)if(typeof value==='string'&&value.trim())return value.trim()}
function stringList(...values){return[...new Set(values.flatMap(v=>Array.isArray(v)?v:[v]).filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim()))]}
function researchKey(url){return`linkedin:${crypto.createHash('sha256').update(url).digest('hex')}`}
function companyKey(value){return String(value||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim()}
function companiesMatch(a,b){const x=companyKey(a),y=companyKey(b);if(!x||!y)return false;return x===y||x.includes(y)||y.includes(x)}
function normalizeJobHistory(value){if(!Array.isArray(value))return[];return value.map(row=>({companyName:str(row?.companyName,row?.company),title:str(row?.title,row?.jobTitle),startedAt:str(row?.startedAt,row?.startDate),endedAt:str(row?.endedAt,row?.endDate)})).filter(row=>row.companyName||row.title)}
const CALLING_CODES={US:'1',CA:'1',GB:'44',MA:'212',FR:'33',DE:'49',ES:'34',IT:'39',NL:'31',BE:'32',CH:'41',AT:'43',PT:'351',IE:'353',SE:'46',NO:'47',DK:'45',FI:'358',PL:'48',CZ:'420',RO:'40',HU:'36',GR:'30',TR:'90',IL:'972',AE:'971',SA:'966',QA:'974',EG:'20',DZ:'213',TN:'216',ZA:'27',IN:'91',SG:'65',AU:'61',NZ:'64',JP:'81',KR:'82',CN:'86',HK:'852',TW:'886',MY:'60',ID:'62',PH:'63',TH:'66',VN:'84',PK:'92',BD:'880',NG:'234',KE:'254',GH:'233',MX:'52',BR:'55',AR:'54',CL:'56',CO:'57',PE:'51'};
function normalizePhone(value,countryAbbr){
  const raw=str(value);if(!raw)return null;const noExt=raw.replace(/(?:ext\.?|extension|x)\s*\d+.*$/i,'').trim();
  let digits=noExt.replace(/\D/g,'');if(!digits)return null;
  const country=String(countryAbbr||'').toUpperCase();const cc=CALLING_CODES[country];
  if(noExt.startsWith('+'))return digits.length>=8&&digits.length<=15?`+${digits}`:null;
  if(/^00/.test(noExt)){digits=digits.replace(/^00/,'');return digits.length>=8&&digits.length<=15?`+${digits}`:null}
  if(cc==='1'){
    if(digits.length===10)return`+1${digits}`;
    if(digits.length===11&&digits.startsWith('1'))return`+${digits}`;
    return null;
  }
  if(cc){digits=digits.replace(/^0+/,'');const full=digits.startsWith(cc)?digits:`${cc}${digits}`;return full.length>=8&&full.length<=15?`+${full}`:null}
  if(digits.length>=8&&digits.length<=15)return`+${digits}`;
  return null;
}
function aiScore(value){const n=Number(String(value||'').replace('%',''));return Number.isFinite(n)?n:0}
function emailStatus(value){return String(value||'').trim().toLowerCase()}
function qualityLabel(status,score,selected=false){if(selected)return`Selected · ${status==='valid'?'Valid · ':''}${score}%`;if(status==='valid')return`Valid · ${score}%`;if(status==='invalid')return`Invalid · ${score}%`;return score?`${score}% confidence`:'Provider candidate'}
function selectContactPhones(contact,countryAbbr){
  const rows=[1,2,3].map(i=>({value:normalizePhone(contact?.[`contactPhone${i}`],countryAbbr),raw:str(contact?.[`contactPhone${i}`]),type:(str(contact?.[`contactPhone${i}DataType`])||'').toLowerCase(),score:aiScore(contact?.[`contactPhone${i}TotalAI`]),order:i,sourceField:`contactPhone${i}`})).filter(x=>x.raw);
  const valid=rows.filter(x=>x.value);const seen=new Set();return valid.filter(x=>{if(seen.has(x.value))return false;seen.add(x.value);return true}).sort((a,b)=>{const ap=['mobile','direct'].includes(a.type)?1:0,bp=['mobile','direct'].includes(b.type)?1:0;return bp-ap||b.score-a.score||a.order-b.order}).map(x=>x.value)
}
function buildContactMethods(contact,currentCompany){
  const personCountry=contact?.contactLocation?.countryAbbr||contact?.contactLocation?.countryAlpha2;
  const companyCountry=contact?.companyLocation?.countryAbbr||contact?.companyLocation?.countryAlpha2||personCountry;
  const methods=[],other=[];const seen=new Set();
  const add=(bucket,kind,value,scope,sourceField,{companyName=null,label=null,score=0,status=null,selected=false,rawValue=null,reason=null}={})=>{if(!value)return;const key=`${kind}:${String(value).toLowerCase()}`;if(seen.has(key))return;seen.add(key);bucket.push({kind,value,scope,sourceField,companyName:companyName||null,label:label||null,score:Number(score)||0,status:status||null,selected:Boolean(selected),rawValue:rawValue||null,reason:reason||null})};
  for(let i=1;i<=3;i++){
    const raw=str(contact?.[`contactPhone${i}`]);if(!raw)continue;const value=normalizePhone(raw,personCountry);const type=(str(contact?.[`contactPhone${i}DataType`])||'contact').toLowerCase();const score=aiScore(contact?.[`contactPhone${i}TotalAI`]);
    if(value)add(methods,'phone',value,'person',`contactPhone${i}`,{label:type,score});
    else add(other,'phone',raw,'provider_candidate',`contactPhone${i}`,{label:type,score,rawValue:raw,reason:`Rejected from main contact card: number is not plausible for ${personCountry||'the returned country'}.`});
  }
  for(let i=1;i<=3;i++){
    const raw=str(contact?.[`companyPhone${i}`]);if(!raw)continue;const value=normalizePhone(raw,companyCountry);const score=aiScore(contact?.[`companyPhone${i}TotalAI`]);const type=(str(contact?.[`companyPhone${i}DataType`])||'company').toLowerCase();
    if(!value){add(other,'phone',raw,'provider_candidate',`companyPhone${i}`,{companyName:currentCompany,label:type,score,rawValue:raw,reason:'Rejected from main card because the returned number is not a plausible international number.'});continue}
    if(score>0&&score<50)add(other,'phone',value,'provider_candidate',`companyPhone${i}`,{companyName:currentCompany,label:type,score,reason:'Low-confidence company number returned by Seamless.'});
    else add(methods,'phone',value,'current_company',`companyPhone${i}`,{companyName:currentCompany,label:type==='work'?'work line':'company line',score});
  }
  const personal=(str(contact?.personalEmail)||'').toLowerCase();if(personal)add(methods,'email',personal,'person','personalEmail',{label:'personal email',status:'personal'});
  const candidates=[];
  for(let i=1;i<=3;i++){const value=(str(contact?.[`email${i}`])||'').toLowerCase();if(!value)continue;candidates.push({field:`email${i}`,value,score:aiScore(contact?.[`email${i}TotalAI`]),status:emailStatus(contact?.[`email${i}EmailAI`]),selected:Boolean(contact?.[`email${i}Selected`])})}
  const top=(str(contact?.email)||'').toLowerCase();if(top){const match=candidates.find(x=>x.value===top);if(match)match.selected=true;else candidates.unshift({field:'email',value:top,score:0,status:'',selected:true})}
  for(const row of candidates){
    if(personal&&row.value===personal){if(!methods.some(m=>m.kind==='email'&&m.value===row.value))add(methods,'email',row.value,'person',row.field,{label:'personal email',score:row.score,status:row.status,selected:row.selected});continue}
    const accepted=row.selected||row.status==='valid'||(row.status!=='invalid'&&row.score>=50);
    if(accepted)add(methods,'email',row.value,'current_company',row.field,{companyName:currentCompany,label:row.selected?'selected work email':'work email',score:row.score,status:row.status,selected:row.selected});
    else add(other,'email',row.value,'provider_candidate',row.field,{companyName:currentCompany,label:'email candidate',score:row.score,status:row.status,selected:row.selected,reason:row.status==='invalid'?'Seamless marked this email invalid.':'Low-confidence/unsupported email candidate.'});
  }
  return{methods,other};
}
function companyContexts(currentCompany,currentTitle,history){
  const out=[];const seen=new Set();
  const add=(companyName,title,current=false,startedAt=null,endedAt=null)=>{const key=companyKey(companyName);if(!key||seen.has(key))return;seen.add(key);out.push({companyName,title:title||null,current,startedAt:startedAt||null,endedAt:endedAt||null})};
  add(currentCompany,currentTitle,true);
  for(const h of history||[])add(h.companyName,h.title,false,h.startedAt,h.endedAt);
  return out;
}
function parseContact(contact,fallbackUrl){
  const linkedinUrl=str(contact?.lIProfileUrl,contact?.liProfileUrl,contact?.linkedinUrl)||fallbackUrl;
  const jobHistory=normalizeJobHistory(contact?.jobHistory);
  if(contact?.formerCompany&&!jobHistory.some(j=>companiesMatch(j.companyName,contact.formerCompany)))jobHistory.push({companyName:str(contact.formerCompany),title:str(contact.formerTitle),startedAt:str(contact.formerStartedAt),endedAt:str(contact.formerEndedAt)});
  const company=str(contact?.company,contact?.companyName);const title=str(contact?.title,contact?.jobTitle);
  const built=buildContactMethods(contact,company);const methods=built.methods,otherCandidates=built.other;
  const personMethods=methods.filter(x=>x.scope==='person');
  const companyMethods=methods.filter(x=>x.scope==='current_company');
  const emails=methods.filter(x=>x.kind==='email').map(x=>x.value);
  const phones=methods.filter(x=>x.kind==='phone'&&x.scope==='person').map(x=>x.value);
  const contexts=companyContexts(company,title,jobHistory);
  return{
    id:str(contact?.contactId,contact?.id),fullName:str(contact?.fullName,contact?.name)||[contact?.firstName,contact?.lastName].filter(Boolean).join(' '),
    firstName:str(contact?.firstName),lastName:str(contact?.lastName),company,title,linkedinUrl,
    emails,phones,email:companyMethods.find(x=>x.kind==='email'&&x.selected)?.value||companyMethods.find(x=>x.kind==='email')?.value||personMethods.find(x=>x.kind==='email')?.value||null,phone:personMethods.find(x=>x.kind==='phone')?.value||null,
    contactMethods:methods,personMethods,currentCompanyMethods:companyMethods,otherCandidates,unassignedMethods:[],
    jobHistory,companyContexts:contexts,hasMultipleCompanies:contexts.length>1,
    raw:contact&&typeof contact==='object'?contact:undefined
  };
}
function companyCheck(data,targetCompany){
  const target=str(targetCompany);if(!target)return null;
  if(companiesMatch(data?.company,target))return{targetCompany:target,status:'current',matchedCompany:data.company,message:`Current Seamless role matches ${target}.`};
  const historical=(data?.jobHistory||[]).find(j=>companiesMatch(j.companyName,target));
  if(historical)return{targetCompany:target,status:'former',matchedCompany:historical.companyName,matchedTitle:historical.title,message:`${target} appears in this person's job history, but Seamless returned current contact data for ${data?.company||'another company'}.`};
  return{targetCompany:target,status:'mismatch',matchedCompany:null,message:`Seamless returned ${data?.company||'an unknown current company'}, and ${target} was not found in the returned job history.`};
}
function creditDelta(before,after){return Number.isFinite(before)&&Number.isFinite(after)?before-after:null}
function traceList(value){return Array.isArray(value)?value.filter(Boolean).slice(-60):[]}
function appendTrace(job,...entries){return{...job,diagnosticTrace:traceList([...(job?.diagnosticTrace||[]),...entries.filter(Boolean)])}}

class EnrichmentService{
  constructor(config,store=new SupabaseStore(),rest=null,pool=null,diagnostics=null){
    this.config=config;this.store=store;this.diagnostics=diagnostics||new DiagnosticJournal();
    if(rest){this.rest=rest;this.pool=null;this.keySource='injected';if(rest&&typeof rest==='object'&&'onDiagnostic'in rest)rest.onDiagnostic=record=>this.event('provider_http','request_complete',record)}
    else{this.rest=null;this.pool=pool||new SeamlessRoutePool(config,process.env,null,this.diagnostics);if(pool&&!pool.diagnostics)pool.diagnostics=this.diagnostics;this.keySource=this.pool.size>1?'MULTI_ORG':this.pool.routes[0]?.source||'UNKNOWN'}
    this.event('service','initialized',{architecture:'exact-linkedin-production',keySource:this.keySource,routeCount:this.pool?.size||1,config:{apiBaseUrl:this.config.apiBaseUrl,requestTimeoutMs:this.config.requestTimeoutMs,pollIntervalMs:this.config.pollIntervalMs,maxPolls:this.config.maxPolls},routes:this.pool?.diagnosticState?.()||[{id:'injected',keySource:'injected'}]});
  }
  event(category,event,details={}){try{return this.diagnostics?.add(category,event,details)}catch{return null}}
  resetDiagnostics(reason='manual'){const out=this.diagnostics.reset({reason});this.event('diagnostics','session_reset',{reason,routes:this.pool?.diagnosticState?.()||[{id:'injected',keySource:'injected'}]});return out}
  recordClientEvent(name,details={}){return this.event('client',name,details)}
  diagnosticReport(){
    const snap=this.diagnostics.snapshot({
      architecture:'exact-linkedin-production',
      config:{apiBaseUrl:this.config.apiBaseUrl,requestTimeoutMs:this.config.requestTimeoutMs,pollIntervalMs:this.config.pollIntervalMs,maxPolls:this.config.maxPolls},
      routing:{policy:this.pool?'PRIMARY_UNTIL_EXHAUSTED_THEN_SECONDARY':'SINGLE',routes:this.pool?.diagnosticState?.()||[{id:'injected',keySource:'injected'}]},
      safety:{contactSearchDisabled:true,mcpDisabled:true,maxChargeableContactsPerResearchPost:1,deduplicationEnabled:true,automaticRetryOnAmbiguousFailure:false}
    });
    const http=snap.events.filter(e=>e.category==='provider_http').map(e=>e.details||{});
    const creditTimeline=[];for(const e of snap.events){if(e.category==='credits'&&['route_balance_observed','probe_completed'].includes(e.event)){creditTimeline.push({seq:e.seq,at:e.at,event:e.event,...e.details})}else if(e.category==='provider_http'){const h=e.details?.response?.headers||{};const raw=h['x-publicapi-credits'];if(raw!=null)creditTimeline.push({seq:e.seq,at:e.at,event:'http_credit_header',routeId:e.details?.routeId,keySource:e.details?.keySource,path:e.details?.request?.path,method:e.details?.request?.method,creditsRemaining:Number(raw),rateLimitRemaining:h['x-ratelimit-remaining']??null,rateLimitReset:h['x-ratelimit-reset']??null})}}
    const researchPosts=http.filter(x=>x?.request?.method==='POST'&&x?.request?.path==='/contacts/research');
    const polls=http.filter(x=>x?.request?.method==='GET'&&String(x?.request?.path||'').startsWith('/contacts/research/poll'));
    const balanceReads=http.filter(x=>x?.request?.method==='GET'&&String(x?.request?.path||'').startsWith('/contacts?'));
    const submittedContacts=researchPosts.reduce((n,x)=>n+(Array.isArray(x?.request?.body?.contacts)?x.request.body.contacts.length:0),0);
    const requestIds=[...new Set(researchPosts.flatMap(x=>Array.isArray(x?.response?.body?.requestIds)?x.response.body.requestIds:[]).filter(Boolean))];
    const providerCreditSeries={};for(const row of creditTimeline.filter(x=>Number.isFinite(x.creditsRemaining))){const k=row.routeId||'unknown';(providerCreditSeries[k]??=[]).push({at:row.at,seq:row.seq,credits:row.creditsRemaining,source:row.event,path:row.path||null})}
    const jumps=[];for(const [routeId,rows] of Object.entries(providerCreditSeries)){let last=null;for(const r of rows){if(last&&r.credits!==last.credits)jumps.push({routeId,from:last.credits,to:r.credits,delta:last.credits-r.credits,fromAt:last.at,toAt:r.at,source:r.source,path:r.path});last=r}}
    return{...snap,derived:{providerHttpCallCount:http.length,researchPostCount:researchPosts.length,submittedContacts,pollCount:polls.length,balanceReadCount:balanceReads.length,requestIds,creditTimeline,providerCreditSeries,creditJumps:jumps,automaticFailoverEvents:snap.events.filter(e=>e.category==='routing'&&['route_selected','route_marked_exhausted'].includes(e.event)),clientEventCount:snap.events.filter(e=>e.category==='client').length,invariants:{oneContactPerResearchPost:researchPosts.every(x=>Array.isArray(x?.request?.body?.contacts)&&x.request.body.contacts.length===1),deduplicationCheckNeverSkipped:researchPosts.every(x=>x?.request?.body?.skipDeduplicationCheck===false),noContactSearch:http.every(x=>!String(x?.request?.path||'').includes('/search/contacts')),noMcp:snap.events.every(e=>!JSON.stringify(e).toLowerCase().includes('mcp.seamless')),secretsRedacted:!JSON.stringify(snap.events).match(/"Token"\s*:\s*"(?!\[REDACTED\])/i)}}};
  }
  publicJob(job){if(job?.status==='submitting'&&Date.now()-job.createdAt>120000)return{...job,status:'needs_review',message:'The original Seamless submission could not be confirmed. No automatic retry will be made.'};return job}
  async directResearchRoute(routeId){if(this.pool){if(routeId){const route=this.pool.routeMap.get(routeId);if(!route)throw new Error(`Unknown Seamless route ${routeId}.`);this.event('routing','route_forced_by_request',{routeId,keySource:route.source});return route}return this.pool.chooseResearchRoute({cause:'enrichment_route_preflight'})}return{id:'injected',source:'injected',rest:this.rest,client:this.rest}}
  routeForId(routeId){if(this.pool){const route=this.pool.routeMap.get(routeId);if(!route)throw new Error(`The saved Seamless route ${routeId||'(missing)'} is not configured on this server.`);return route}return{id:'injected',source:'injected',rest:this.rest,client:this.rest}}
  async lookup(linkedinUrl,targetCompany){
    const url=normalizeLinkedInUrl(linkedinUrl);const key=researchKey(url);this.event('lookup','started',{linkedinUrl:url,researchKey:key,targetCompany:str(targetCompany)||null});
    await this.store.ensurePerson(url);this.event('storage','person_ensured',{linkedinUrl:url});const existing=await this.store.getResearch(key);this.event('storage','research_cache_checked',{researchKey:key,hit:Boolean(existing),status:existing?.status||null,routeId:existing?.routeId||null});
    if(existing?.status==='done'){const job={...this.publicJob(existing)};job.companyCheck=companyCheck(job.data,targetCompany||job.targetCompany);this.event('lookup','cache_hit',{linkedinUrl:url,researchKey:key,status:job.status,company:job.data?.company||null});return{linkedinUrl:url,cached:true,job,readyToResearch:false,mode:'cached'}}
    const out={linkedinUrl:url,cached:false,job:existing?this.publicJob(existing):null,readyToResearch:!existing,targetCompany:str(targetCompany)||null,mode:'exact-linkedin-direct',researchPlan:{contacts:1,maxChargeableSubmissions:1,identity:'liProfileUrl',deduplication:'enabled',searchEndpointsUsed:false}};this.event('lookup','completed',{linkedinUrl:url,cached:false,readyToResearch:out.readyToResearch,existingStatus:existing?.status||null});return out;
  }
  async startResearch(input){return this.startDirectResearch(input?.linkedinUrl||input,input?.targetCompany,input?.routeId)}
  async routePreflight(requestedRouteId){
    this.event('research','preflight_started',{requestedRouteId:str(requestedRouteId)||null});const route=await this.directResearchRoute(str(requestedRouteId));let beforeCredits=route.lastCredits??null,beforeObservedAt=route.lastCreditsAt??null,beforeDiagnostic=route.lastCreditDiagnostic||null;
    if(!this.pool||requestedRouteId){try{const before=await (route.rest||route.client).getCredits();beforeCredits=before.creditsRemaining;beforeObservedAt=before.observedAt;beforeDiagnostic=before.diagnostic||null;if(this.pool)this.pool.noteCredits(route,before,'explicit_preflight')}catch(error){beforeDiagnostic=error?.diagnostic||beforeDiagnostic;this.event('research','preflight_credit_probe_failed',{routeId:route.id,keySource:route.source,message:error.message||String(error),providerDiagnostic:error?.diagnostic||null})}}
    this.event('research','preflight_completed',{routeId:route.id,keySource:route.source,beforeCredits,beforeObservedAt,creditSource:'X-PublicAPI-Credits'});return{route,beforeCredits,beforeObservedAt,beforeDiagnostic};
  }
  async submitOnRoute(key,baseClaim,route,beforeCredits,beforeObservedAt,{failoverFrom=null}={}){
    const rest=route.rest||route.client;let claim={...baseClaim,routeId:route.id,keySource:route.source,beforeCredits,beforeCreditsObservedAt:beforeObservedAt,failoverFrom,safeFailoverReason:failoverFrom?'primary returned explicit insufficientCredits before any research could run':null};
    this.event('research','submission_attempt',{researchKey:key,routeId:route.id,keySource:route.source,linkedinUrl:claim.normalizedUrl,contacts:1,beforeCredits,failoverFrom,automaticRetry:false,deduplication:'enabled'});
    if(failoverFrom){await this.store.saveResearch(key,claim);this.event('storage','research_job_saved',{researchKey:key,status:claim.status,reason:'failover_route_update'})}
    let response;try{response=await rest.researchLinkedIn(claim.normalizedUrl)}catch(error){if(error?.diagnostic){claim=appendTrace(claim,error.diagnostic);await this.store.saveResearch(key,claim).catch(()=>{})}this.event('research','submission_error',{researchKey:key,routeId:route.id,message:error.message||String(error),code:error?.code||null,status:error?.status||null,creditsRemaining:error?.creditsRemaining??null,providerDiagnostic:error?.diagnostic||null});throw error}
    claim=appendTrace(claim,response.diagnostic);
    const ids=Array.isArray(response.data?.requestIds)?response.data.requestIds.filter(Boolean):[];const afterCredits=response.creditsRemaining??null;const debit=creditDelta(beforeCredits,afterCredits);
    this.event('research','submission_response',{researchKey:key,routeId:route.id,keySource:route.source,httpCredits:afterCredits,observedAt:response.observedAt,requestIds:ids,requestIdCount:ids.length,creditDeltaFromPreflight:debit});
    if(ids.length!==1){const next={...claim,status:'needs_review',requestIds:ids,updatedAt:Date.now(),afterCredits,afterCreditsObservedAt:response.observedAt,creditDelta:debit,creditAnomaly:Number.isFinite(debit)&&debit>1,message:`Seamless returned ${ids.length} request IDs for one submitted LinkedIn profile. Beast will not continue automatically.`};await this.store.saveResearch(key,next);this.event('storage','research_job_saved',{researchKey:key,status:next.status,requestIds:ids});return next}
    const next={...claim,status:'processing',requestIds:[ids[0]],updatedAt:Date.now(),afterCredits,afterCreditsObservedAt:response.observedAt,creditDelta:debit,creditAnomaly:Number.isFinite(debit)&&debit>1};await this.store.saveResearch(key,next);this.event('storage','research_job_saved',{researchKey:key,status:next.status,requestIds:next.requestIds,routeId:next.routeId});return next;
  }
  async startDirectResearch(linkedinUrl,targetCompany,requestedRouteId){
    const url=normalizeLinkedInUrl(linkedinUrl);const key=researchKey(url);this.event('research','start_requested',{linkedinUrl:url,researchKey:key,targetCompany:str(targetCompany)||null,requestedRouteId:str(requestedRouteId)||null});await this.store.ensurePerson(url);const existing=await this.store.getResearch(key);if(existing){this.event('research','start_short_circuited_existing_job',{researchKey:key,status:existing.status,cached:existing.status==='done'});return{...this.publicJob(existing),cached:existing.status==='done'}}
    const pre=await this.routePreflight(requestedRouteId);const baseClaim={mode:'direct-linkedin-rest',transport:'REST',status:'submitting',normalizedUrl:url,researchKey:key,targetCompany:str(targetCompany)||null,routeId:pre.route.id,keySource:pre.route.source,createdAt:Date.now(),submittedContacts:1,maxChargeableSubmissions:1,beforeCredits:pre.beforeCredits,beforeCreditsObservedAt:pre.beforeObservedAt,diagnosticTrace:traceList([pre.beforeDiagnostic])};
    if(!await this.store.claimResearch(key,url,baseClaim)){const winner=await this.store.getResearch(key);this.event('storage','research_claim_lost',{researchKey:key,winnerStatus:winner?.status||null});if(!winner)throw new Error('Could not confirm the research state. No new Seamless request was submitted.');return this.publicJob(winner)}
    this.event('storage','research_claim_acquired',{researchKey:key,routeId:pre.route.id,status:'submitting'});
    try{return await this.submitOnRoute(key,baseClaim,pre.route,pre.beforeCredits,pre.beforeObservedAt)}catch(error){
      if(this.pool&&!requestedRouteId&&error instanceof SeamlessRestError&&error.code==='insufficientCredits'){
        this.pool.markExhausted(pre.route.id);this.event('routing','safe_failover_triggered',{fromRouteId:pre.route.id,reason:'explicit_insufficientCredits',ambiguous:false});
        try{const fallback=await this.pool.chooseResearchRoute({afterRouteId:pre.route.id,cause:'safe_insufficient_credits_failover'});return await this.submitOnRoute(key,baseClaim,fallback,fallback.lastCredits,fallback.lastCreditsAt,{failoverFrom:pre.route.id})}catch(fallbackError){const current=await this.store.getResearch(key)||baseClaim;return this.handleSubmissionError(key,current,fallbackError)}
      }
      return this.handleSubmissionError(key,baseClaim,error)
    }
  }
  async handleSubmissionError(key,claim,error){
    const traced=error?.diagnostic?appendTrace(claim,error.diagnostic):claim;
    if(error instanceof SeamlessRestError&&[400,401,403,404,422,429].includes(error.status)){await this.store.deleteResearch(key).catch(()=>{});this.event('storage','research_claim_deleted',{researchKey:key,reason:'definitive_provider_rejection',status:error.status,code:error.code});error.diagnosticTrace=traceList(traced.diagnosticTrace);throw error}
    const safe={...traced,status:'needs_review',updatedAt:Date.now(),afterCredits:error instanceof SeamlessRestError?error.creditsRemaining??null:null,message:`${error?.message||'The Seamless submission outcome is uncertain.'} No automatic retry was made.`};await this.store.saveResearch(key,safe).catch(()=>{});this.event('research','ambiguous_failure_quarantined',{researchKey:key,message:safe.message,automaticRetry:false});throw error
  }
  async pollResearch(input){
    const url=normalizeLinkedInUrl(typeof input==='string'?input:input?.linkedinUrl);const key=researchKey(url);let job=await this.store.getResearch(key);this.event('poll','requested',{linkedinUrl:url,researchKey:key,storedStatus:job?.status||null,requestIds:job?.requestIds||[]});if(!job)return{status:'not_found'};if(job.status!=='processing'||job.requestIds?.length!==1){this.event('poll','short_circuited',{researchKey:key,status:job.status,requestIdCount:job.requestIds?.length||0});return this.publicJob(job)}
    const route=this.routeForId(job.routeId);const rest=route.rest||route.client;let response;try{response=await rest.pollContactResearch(job.requestIds)}catch(error){if(error?.diagnostic){job=appendTrace(job,error.diagnostic);await this.store.saveResearch(key,job).catch(()=>{})}this.event('poll','provider_error',{researchKey:key,routeId:route.id,message:error.message||String(error),providerDiagnostic:error?.diagnostic||null});throw error}
    job=appendTrace(job,response.diagnostic);const rows=Array.isArray(response.data?.data)?response.data.data:[];const row=rows.find(item=>item?.requestId===job.requestIds[0])||rows[0];this.event('poll','provider_response',{researchKey:key,routeId:route.id,httpCredits:response.creditsRemaining??null,observedAt:response.observedAt,rowCount:rows.length,matchedRequestId:row?.requestId||null,providerStatus:row?.status||null,searchResultId:row?.searchResultId||null});
    if(!row){const next={...job,updatedAt:Date.now(),message:'Research is still processing.'};await this.store.saveResearch(key,next);return next}
    const providerStatus=String(row.status||'').toLowerCase();
    if(providerStatus==='done'||providerStatus==='duplicate'){
      const data=row.contact?parseContact(row.contact,job.normalizedUrl):undefined;this.event('parse','contact_received',{researchKey:key,providerStatus,hasContact:Boolean(row.contact),rawFieldCount:row.contact&&typeof row.contact==='object'?Object.keys(row.contact).length:0,parsed:{fullName:data?.fullName||null,company:data?.company||null,title:data?.title||null,emailCount:data?.emails?.length||0,personPhoneCount:data?.phones?.length||0,contactMethodCount:data?.contactMethods?.length||0,jobHistoryCount:data?.jobHistory?.length||0,hasMultipleCompanies:data?.hasMultipleCompanies||false}});
      if(!data){const next={...job,status:providerStatus==='duplicate'?'duplicate':'needs_review',providerStatus,updatedAt:Date.now(),message:row.message||'Seamless returned no contact record. No second research request was submitted.'};await this.store.saveResearch(key,next);return next}
      let freshCredits=response.creditsRemaining??null,freshObservedAt=response.observedAt;this.event('credits','final_reconciliation_started',{researchKey:key,routeId:route.id,pollHeaderCredits:freshCredits});try{const fresh=await rest.getCredits();if(fresh.diagnostic)job=appendTrace(job,fresh.diagnostic);if(Number.isFinite(fresh.creditsRemaining)){freshCredits=fresh.creditsRemaining;freshObservedAt=fresh.observedAt;if(this.pool)this.pool.noteCredits(route,fresh,'post_research_final_reconciliation')}this.event('credits','final_reconciliation_completed',{researchKey:key,routeId:route.id,creditsRemaining:freshCredits,observedAt:freshObservedAt})}catch(error){if(error?.diagnostic)job=appendTrace(job,error.diagnostic);this.event('credits','final_reconciliation_failed',{researchKey:key,routeId:route.id,message:error.message||String(error),fallbackCredits:freshCredits})}
      const debit=creditDelta(job.beforeCredits,freshCredits);const next={...job,status:'done',providerStatus,data,companyCheck:companyCheck(data,job.targetCompany),updatedAt:Date.now(),afterCredits:freshCredits,afterCreditsObservedAt:freshObservedAt,creditDelta:debit,creditAnomaly:Number.isFinite(debit)&&debit>1};await this.store.saveResearch(key,next);this.event('research','completed',{researchKey:key,routeId:route.id,providerStatus,beforeCredits:job.beforeCredits,afterCredits:freshCredits,observedDebit:debit,creditAnomaly:next.creditAnomaly,requestIds:job.requestIds,company:data.company,fullName:data.fullName});return next;
    }
    if(providerStatus==='missing'||providerStatus==='error'){const next={...job,status:providerStatus==='missing'?'missing':'failed',providerStatus,updatedAt:Date.now(),message:row.message||`Seamless research ${providerStatus}.`};await this.store.saveResearch(key,next);this.event('research','provider_terminal_failure',{researchKey:key,providerStatus,message:next.message});return next}
    const next={...job,providerStatus:providerStatus||job.providerStatus,updatedAt:Date.now(),afterCredits:response.creditsRemaining??job.afterCredits,afterCreditsObservedAt:response.observedAt};await this.store.saveResearch(key,next);return next;
  }
  async ready(){this.event('database','ready_check_started',{});try{await this.store.ready();this.event('database','ready_check_completed',{status:'READY'})}catch(error){this.event('database','ready_check_completed',{status:'ERROR',message:error.message});throw error}}
  async status(context={}){
    const reason=str(context?.reason)||'unspecified';const result={architecture:'exact-linkedin-production',keySource:this.keySource,database:{status:'ERROR'},seamless:{status:'CONFIGURED',transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxChargeableSubmissions:1},credits:null};this.event('status','application_status_requested',{reason});
    try{await this.store.ready();result.database={status:'READY'}}catch(error){result.database={status:'ERROR',error:error.message}}
    try{
      if(this.pool){const provider=await this.pool.status(reason);result.seamless={status:provider.status,transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxChargeableSubmissions:1,routePolicy:'PRIMARY_UNTIL_EXHAUSTED_THEN_SECONDARY',organizationCount:provider.organizationCount,activeRouteId:provider.activeRouteId};result.credits=provider}
      else{const credits=await this.rest.getCredits();result.seamless={status:'READY',transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxChargeableSubmissions:1,routePolicy:'SINGLE',organizationCount:1,activeRouteId:'injected'};result.credits={status:Number.isFinite(credits.creditsRemaining)?'READY':'ERROR',organizationCount:1,activeRouteId:'injected',totalCreditsRemaining:Number.isFinite(credits.creditsRemaining)?credits.creditsRemaining:null,allFresh:Number.isFinite(credits.creditsRemaining),balanceSource:'X-PublicAPI-Credits',routes:[{id:'injected',keySource:'injected',status:Number.isFinite(credits.creditsRemaining)?'READY':'ERROR',fresh:Number.isFinite(credits.creditsRemaining),usageState:Number.isFinite(credits.creditsRemaining)&&credits.creditsRemaining>0?'ACTIVE':'EXHAUSTED',creditsRemaining:Number.isFinite(credits.creditsRemaining)?credits.creditsRemaining:null,observedAt:Number.isFinite(credits.creditsRemaining)?credits.observedAt:null}]}}
    }catch(error){result.seamless={status:'ERROR',transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxChargeableSubmissions:1,error:error.message}}
    this.event('status','application_status_completed',{reason,database:result.database,seamless:result.seamless,credits:result.credits});return result;
  }
}
module.exports={EnrichmentService,researchKey,parseContact,companyCheck,companiesMatch,creditDelta,normalizePhone,companyContexts,selectContactPhones,buildContactMethods,traceList,appendTrace};
