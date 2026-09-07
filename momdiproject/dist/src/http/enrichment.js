'use strict';
const crypto=require('node:crypto');
const {SeamlessRestError}=require('../seamless/restClient');
const {SeamlessRoutePool}=require('../seamless/routePool');
const {SupabaseStore}=require('../storage/supabase');
const {normalizeLinkedInUrl}=require('../utils/normalizeUrl');

function str(...values){for(const value of values)if(typeof value==='string'&&value.trim())return value.trim()}
function stringList(...values){return[...new Set(values.flatMap(v=>Array.isArray(v)?v:[v]).filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim()))]}
function researchKey(url){return`linkedin:${crypto.createHash('sha256').update(url).digest('hex')}`}
function companyKey(value){return String(value||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim()}
function companiesMatch(a,b){const x=companyKey(a),y=companyKey(b);if(!x||!y)return false;return x===y||x.includes(y)||y.includes(x)}
function normalizeJobHistory(value){if(!Array.isArray(value))return[];return value.map(row=>({companyName:str(row?.companyName,row?.company),title:str(row?.title,row?.jobTitle),startedAt:str(row?.startedAt,row?.startDate),endedAt:str(row?.endedAt,row?.endDate)})).filter(row=>row.companyName||row.title)}
const CALLING_CODES={US:'1',CA:'1',GB:'44',MA:'212',FR:'33',DE:'49',ES:'34',IT:'39',NL:'31',BE:'32',CH:'41',AT:'43',PT:'351',IE:'353',SE:'46',NO:'47',DK:'45',FI:'358',PL:'48',CZ:'420',RO:'40',HU:'36',GR:'30',TR:'90',IL:'972',AE:'971',SA:'966',QA:'974',EG:'20',DZ:'213',TN:'216',ZA:'27',IN:'91',SG:'65',AU:'61',NZ:'64',JP:'81',KR:'82',CN:'86',HK:'852',TW:'886',MY:'60',ID:'62',PH:'63',TH:'66',VN:'84',PK:'92',BD:'880',NG:'234',KE:'254',GH:'233',MX:'52',BR:'55',AR:'54',CL:'56',CO:'57',PE:'51'};
function normalizePhone(value,countryAbbr){
  const raw=str(value);if(!raw)return null;const noExt=raw.replace(/(?:ext\.?|extension|x)\s*\d+.*$/i,'').trim();
  if(noExt.startsWith('+')){const digits=noExt.replace(/\D/g,'');return digits?`+${digits}`:null}
  if(/^00/.test(noExt)){const digits=noExt.replace(/\D/g,'').replace(/^00/,'');return digits?`+${digits}`:null}
  let digits=noExt.replace(/\D/g,'');if(!digits)return null;const cc=CALLING_CODES[String(countryAbbr||'').toUpperCase()];
  if(cc==='1'){if(digits.length===10)return`+1${digits}`;if(digits.length===11&&digits.startsWith('1'))return`+${digits}`}
  if(cc){digits=digits.replace(/^0+/,'');if(digits.startsWith(cc))return`+${digits}`;return`+${cc}${digits}`}
  if(digits.length===11&&digits.startsWith('1'))return`+${digits}`;
  return raw;
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
  const contactCountry=contact?.contactLocation?.countryAbbr||contact?.contactLocation?.countryAlpha2;const companyCountry=contact?.companyLocation?.countryAbbr||contact?.companyLocation?.countryAlpha2||contactCountry;
  const emails=stringList(contact?.email,contact?.email1,contact?.email2,contact?.email3,contact?.personalEmail).map(x=>x.toLowerCase());
  const phones=stringList(
    normalizePhone(contact?.contactPhone1,contactCountry),normalizePhone(contact?.contactPhone2,contactCountry),
    normalizePhone(contact?.companyPhone1,companyCountry),normalizePhone(contact?.companyPhone2,companyCountry),normalizePhone(contact?.companyPhone3,companyCountry)
  ).filter(Boolean);
  const company=str(contact?.company,contact?.companyName);const title=str(contact?.title,contact?.jobTitle);
  return{
    id:str(contact?.contactId,contact?.id),fullName:str(contact?.fullName,contact?.name)||[contact?.firstName,contact?.lastName].filter(Boolean).join(' '),
    firstName:str(contact?.firstName),lastName:str(contact?.lastName),company,title,linkedinUrl,
    emails,phones,email:emails[0]||null,phone:phones[0]||null,
    jobHistory,companyContexts:companyContexts(company,title,jobHistory),hasMultipleCompanies:companyContexts(company,title,jobHistory).length>1,
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

class EnrichmentService{
  constructor(config,store=new SupabaseStore(),rest=null,pool=null){this.config=config;this.store=store;if(rest){this.rest=rest;this.pool=null;this.keySource='injected'}else{this.rest=null;this.pool=pool||new SeamlessRoutePool(config);this.keySource=this.pool.size>1?'MULTI_ORG':this.pool.routes[0]?.source||'UNKNOWN'}}
  publicJob(job){if(job?.status==='submitting'&&Date.now()-job.createdAt>120000)return{...job,status:'needs_review',message:'The original Seamless submission could not be confirmed. No automatic retry will be made.'};return job}
  async directResearchRoute(routeId){if(this.pool){if(routeId){const route=this.pool.routeMap.get(routeId);if(!route)throw new Error(`Unknown Seamless route ${routeId}.`);await this.pool.assertUniqueEgress();return route}return this.pool.chooseResearchRoute()}return{id:'injected',source:'injected',rest:this.rest,client:this.rest}}
  routeForId(routeId){if(this.pool){const route=this.pool.routeMap.get(routeId);if(!route)throw new Error(`The saved Seamless route ${routeId||'(missing)'} is not configured on this server.`);return route}return{id:'injected',source:'injected',rest:this.rest,client:this.rest}}
  async lookup(linkedinUrl,targetCompany){
    const url=normalizeLinkedInUrl(linkedinUrl);await this.store.ensurePerson(url);const key=researchKey(url);const existing=await this.store.getResearch(key);
    if(existing?.status==='done'){const job={...this.publicJob(existing)};job.companyCheck=companyCheck(job.data,targetCompany||job.targetCompany);return{linkedinUrl:url,cached:true,job,readyToResearch:false,mode:'cached'}}
    return{linkedinUrl:url,cached:false,job:existing?this.publicJob(existing):null,readyToResearch:!existing,targetCompany:str(targetCompany)||null,mode:'exact-linkedin-direct',researchPlan:{contacts:1,maxChargeableSubmissions:1,identity:'liProfileUrl',deduplication:'enabled',searchEndpointsUsed:false}};
  }
  async startResearch(input){return this.startDirectResearch(input?.linkedinUrl||input,input?.targetCompany,input?.routeId)}
  async routePreflight(requestedRouteId){
    const route=await this.directResearchRoute(str(requestedRouteId));let beforeCredits=route.lastCredits??null,beforeObservedAt=route.lastCreditsAt??null;
    if(!this.pool||requestedRouteId){try{const before=await (route.rest||route.client).getCredits();beforeCredits=before.creditsRemaining;beforeObservedAt=before.observedAt}catch{}}
    return{route,beforeCredits,beforeObservedAt};
  }
  async submitOnRoute(key,baseClaim,route,beforeCredits,beforeObservedAt,{failoverFrom=null}={}){
    const rest=route.rest||route.client;const claim={...baseClaim,routeId:route.id,keySource:route.source,beforeCredits,beforeCreditsObservedAt:beforeObservedAt,failoverFrom,safeFailoverReason:failoverFrom?'primary returned explicit insufficientCredits before any research could run':null};
    if(failoverFrom)await this.store.saveResearch(key,claim);
    const response=await rest.researchLinkedIn(claim.normalizedUrl);const ids=Array.isArray(response.data?.requestIds)?response.data.requestIds.filter(Boolean):[];const afterCredits=response.creditsRemaining??null;const debit=creditDelta(beforeCredits,afterCredits);
    if(ids.length!==1){const next={...claim,status:'needs_review',requestIds:ids,updatedAt:Date.now(),afterCredits,afterCreditsObservedAt:response.observedAt,creditDelta:debit,creditAnomaly:Number.isFinite(debit)&&debit>1,message:`Seamless returned ${ids.length} request IDs for one submitted LinkedIn profile. Beast will not continue automatically.`};await this.store.saveResearch(key,next);return next}
    const next={...claim,status:'processing',requestIds:[ids[0]],updatedAt:Date.now(),afterCredits,afterCreditsObservedAt:response.observedAt,creditDelta:debit,creditAnomaly:Number.isFinite(debit)&&debit>1};await this.store.saveResearch(key,next);return next;
  }
  async startDirectResearch(linkedinUrl,targetCompany,requestedRouteId){
    const url=normalizeLinkedInUrl(linkedinUrl);await this.store.ensurePerson(url);const key=researchKey(url);const existing=await this.store.getResearch(key);if(existing)return{...this.publicJob(existing),cached:existing.status==='done'};
    const pre=await this.routePreflight(requestedRouteId);const baseClaim={mode:'direct-linkedin-rest',transport:'REST',status:'submitting',normalizedUrl:url,researchKey:key,targetCompany:str(targetCompany)||null,routeId:pre.route.id,keySource:pre.route.source,createdAt:Date.now(),submittedContacts:1,maxChargeableSubmissions:1,beforeCredits:pre.beforeCredits,beforeCreditsObservedAt:pre.beforeObservedAt};
    if(!await this.store.claimResearch(key,url,baseClaim)){const winner=await this.store.getResearch(key);if(!winner)throw new Error('Could not confirm the research state. No new Seamless request was submitted.');return this.publicJob(winner)}
    try{return await this.submitOnRoute(key,baseClaim,pre.route,pre.beforeCredits,pre.beforeObservedAt)}catch(error){
      if(this.pool&&!requestedRouteId&&error instanceof SeamlessRestError&&error.code==='insufficientCredits'){
        this.pool.markExhausted(pre.route.id);
        try{const fallback=await this.pool.chooseResearchRoute({afterRouteId:pre.route.id});return await this.submitOnRoute(key,baseClaim,fallback,fallback.lastCredits,fallback.lastCreditsAt,{failoverFrom:pre.route.id})}catch(fallbackError){const current=await this.store.getResearch(key)||baseClaim;return this.handleSubmissionError(key,current,fallbackError)}
      }
      return this.handleSubmissionError(key,baseClaim,error)
    }
  }
  async handleSubmissionError(key,claim,error){
    if(error instanceof SeamlessRestError&&[400,401,403,404,422,429].includes(error.status)){await this.store.deleteResearch(key).catch(()=>{});throw error}
    const safe={...claim,status:'needs_review',updatedAt:Date.now(),afterCredits:error instanceof SeamlessRestError?error.creditsRemaining??null:null,message:`${error?.message||'The Seamless submission outcome is uncertain.'} No automatic retry was made.`};await this.store.saveResearch(key,safe).catch(()=>{});throw error
  }
  async pollResearch(input){
    const url=normalizeLinkedInUrl(typeof input==='string'?input:input?.linkedinUrl);const key=researchKey(url);const job=await this.store.getResearch(key);if(!job)return{status:'not_found'};if(job.status!=='processing'||job.requestIds?.length!==1)return this.publicJob(job);
    const route=this.routeForId(job.routeId);const rest=route.rest||route.client;const response=await rest.pollContactResearch(job.requestIds);const rows=Array.isArray(response.data?.data)?response.data.data:[];const row=rows.find(item=>item?.requestId===job.requestIds[0])||rows[0];if(!row)return{...job,message:'Research is still processing.'};
    const providerStatus=String(row.status||'').toLowerCase();
    if(providerStatus==='done'||providerStatus==='duplicate'){
      const data=row.contact?parseContact(row.contact,job.normalizedUrl):undefined;
      if(!data){const next={...job,status:providerStatus==='duplicate'?'duplicate':'needs_review',providerStatus,updatedAt:Date.now(),message:row.message||'Seamless returned no contact record. No second research request was submitted.'};await this.store.saveResearch(key,next);return next}
      let freshCredits=response.creditsRemaining??null,freshObservedAt=response.observedAt;try{const fresh=await rest.getCredits();if(Number.isFinite(fresh.creditsRemaining)){freshCredits=fresh.creditsRemaining;freshObservedAt=fresh.observedAt;if(this.pool)this.pool.noteCredits(route,fresh)}}catch{}
      const debit=creditDelta(job.beforeCredits,freshCredits);const next={...job,status:'done',providerStatus,data,companyCheck:companyCheck(data,job.targetCompany),updatedAt:Date.now(),afterCredits:freshCredits,afterCreditsObservedAt:freshObservedAt,creditDelta:debit,creditAnomaly:Number.isFinite(debit)&&debit>1};await this.store.saveResearch(key,next);return next;
    }
    if(providerStatus==='missing'||providerStatus==='error'){const next={...job,status:providerStatus==='missing'?'missing':'failed',providerStatus,updatedAt:Date.now(),message:row.message||`Seamless research ${providerStatus}.`};await this.store.saveResearch(key,next);return next}
    return{...job,providerStatus:providerStatus||job.providerStatus,afterCredits:response.creditsRemaining??job.afterCredits,afterCreditsObservedAt:response.observedAt};
  }
  async ready(){await this.store.ready();if(this.pool&&this.pool.requireUniqueEgress)await this.pool.assertUniqueEgress()}
  async status(){
    const result={architecture:'exact-linkedin-priority-failover',keySource:this.keySource,database:{status:'ERROR'},seamless:{status:'CONFIGURED',transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxChargeableSubmissions:1},credits:null};
    try{await this.store.ready();result.database={status:'READY'}}catch(error){result.database={status:'ERROR',error:error.message}}
    try{
      if(this.pool){const provider=await this.pool.status();result.seamless={status:provider.status,transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxChargeableSubmissions:1,routePolicy:'PRIMARY_UNTIL_EXHAUSTED_THEN_SECONDARY',organizationCount:provider.organizationCount,activeRouteId:provider.activeRouteId,uniqueEgressRequired:provider.uniqueEgressRequired,uniqueEgressVerified:provider.uniqueEgressVerified,error:provider.error};result.credits=provider}
      else{const credits=await this.rest.getCredits();result.seamless={status:'READY',transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxChargeableSubmissions:1,routePolicy:'SINGLE',organizationCount:1,activeRouteId:'injected',uniqueEgressRequired:false,uniqueEgressVerified:true};result.credits={status:'READY',organizationCount:1,activeRouteId:'injected',totalCreditsRemaining:credits.creditsRemaining,routes:[{id:'injected',keySource:'injected',status:'READY',usageState:'ACTIVE',creditsRemaining:credits.creditsRemaining,observedAt:credits.observedAt,proxyConfigured:false}]}}
    }catch(error){result.seamless={status:'ERROR',transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxChargeableSubmissions:1,error:error.message}}
    return result;
  }
}
module.exports={EnrichmentService,researchKey,parseContact,companyCheck,companiesMatch,creditDelta,normalizePhone,companyContexts};
