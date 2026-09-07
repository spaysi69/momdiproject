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
function parseContact(contact,fallbackUrl){
  const linkedinUrl=str(contact?.lIProfileUrl,contact?.liProfileUrl,contact?.linkedinUrl)||fallbackUrl;
  const jobHistory=normalizeJobHistory(contact?.jobHistory);
  if(contact?.formerCompany&&!jobHistory.some(j=>companiesMatch(j.companyName,contact.formerCompany)))jobHistory.push({companyName:str(contact.formerCompany),title:str(contact.formerTitle),startedAt:str(contact.formerStartedAt),endedAt:str(contact.formerEndedAt)});
  return{
    id:str(contact?.contactId,contact?.id),
    fullName:str(contact?.fullName,contact?.name)||[contact?.firstName,contact?.lastName].filter(Boolean).join(' '),
    firstName:str(contact?.firstName),lastName:str(contact?.lastName),
    title:str(contact?.title,contact?.jobTitle),company:str(contact?.company,contact?.companyName),
    email:str(contact?.email,contact?.email1),phone:str(contact?.contactPhone1,contact?.phone),linkedinUrl,
    department:str(contact?.department),seniority:str(contact?.seniority),
    alternateEmails:stringList(contact?.email2,contact?.email3,contact?.personalEmail),
    alternatePhones:stringList(contact?.contactPhone2,contact?.companyPhone1,contact?.companyPhone2,contact?.companyPhone3),
    companyDomain:str(contact?.companyDomain,contact?.website),companyLinkedInUrl:str(contact?.companyLIProfileUrl,contact?.companyLinkedInUrl),
    contactLocation:contact?.contactLocation&&typeof contact.contactLocation==='object'?contact.contactLocation:undefined,
    companyLocation:contact?.companyLocation&&typeof contact.companyLocation==='object'?contact.companyLocation:undefined,
    jobHistory,formerCompany:str(contact?.formerCompany),formerTitle:str(contact?.formerTitle),
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
  constructor(config,store=new SupabaseStore(),rest=null,pool=null){
    this.config=config;this.store=store;
    if(rest){this.rest=rest;this.pool=null;this.keySource='injected'}
    else{this.rest=null;this.pool=pool||new SeamlessRoutePool(config);this.keySource=this.pool.size>1?'MULTI_ORG':this.pool.routes[0]?.source||'UNKNOWN'}
  }
  publicJob(job){if(job?.status==='submitting'&&Date.now()-job.createdAt>120000)return{...job,status:'needs_review',message:'The original Seamless submission could not be confirmed. No automatic retry will be made.'};return job}
  async directResearchRoute(routeId){
    if(this.pool){if(routeId){const route=this.pool.routeMap.get(routeId);if(!route)throw new Error(`Unknown Seamless route ${routeId}.`);await this.pool.assertUniqueEgress();return route}return this.pool.chooseResearchRoute()}
    return{id:'injected',source:'injected',rest:this.rest,client:this.rest};
  }
  routeForId(routeId){if(this.pool){const route=this.pool.routeMap.get(routeId);if(!route)throw new Error(`The saved Seamless route ${routeId||'(missing)'} is not configured on this server.`);return route}return{id:'injected',source:'injected',rest:this.rest,client:this.rest}}
  async lookup(linkedinUrl,targetCompany){
    const url=normalizeLinkedInUrl(linkedinUrl);await this.store.ensurePerson(url);const key=researchKey(url);const existing=await this.store.getResearch(key);
    if(existing?.status==='done'){
      const job={...this.publicJob(existing)};job.companyCheck=companyCheck(job.data,targetCompany||job.targetCompany);return{linkedinUrl:url,cached:true,job,readyToResearch:false,mode:'cached'};
    }
    return{linkedinUrl:url,cached:false,job:existing?this.publicJob(existing):null,readyToResearch:!existing,targetCompany:str(targetCompany)||null,mode:'exact-linkedin-direct',researchPlan:{contacts:1,maxAutomaticResearchSubmissions:1,identity:'liProfileUrl',deduplication:'enabled',searchEndpointsUsed:false}};
  }
  async startResearch(input){return this.startDirectResearch(input?.linkedinUrl||input,input?.targetCompany,input?.routeId)}
  async startDirectResearch(linkedinUrl,targetCompany,requestedRouteId){
    const url=normalizeLinkedInUrl(linkedinUrl);await this.store.ensurePerson(url);const key=researchKey(url);const existing=await this.store.getResearch(key);if(existing)return{...this.publicJob(existing),cached:existing.status==='done'};
    const route=await this.directResearchRoute(str(requestedRouteId));const rest=route.rest||route.client;if(!rest?.researchLinkedIn)throw new Error('Direct LinkedIn research is not configured for this route.');
    let beforeCredits=null,beforeObservedAt=null;try{const before=await rest.getCredits();beforeCredits=before.creditsRemaining;beforeObservedAt=before.observedAt}catch{}
    const claim={mode:'direct-linkedin-rest',transport:'REST',status:'submitting',normalizedUrl:url,researchKey:key,targetCompany:str(targetCompany)||null,routeId:route.id,keySource:route.source,createdAt:Date.now(),submittedContacts:1,maxAutomaticResearchSubmissions:1,beforeCredits,beforeCreditsObservedAt:beforeObservedAt};
    if(!await this.store.claimResearch(key,url,claim)){const winner=await this.store.getResearch(key);if(!winner)throw new Error('Could not confirm the research state. No new Seamless request was submitted.');return this.publicJob(winner)}
    try{
      const response=await rest.researchLinkedIn(url);const ids=Array.isArray(response.data?.requestIds)?response.data.requestIds.filter(Boolean):[];const afterCredits=response.creditsRemaining??null;const debit=creditDelta(beforeCredits,afterCredits);
      if(ids.length!==1){const next={...claim,status:'needs_review',requestIds:ids,updatedAt:Date.now(),afterCredits,afterCreditsObservedAt:response.observedAt,creditDelta:debit,creditAnomaly:Number.isFinite(debit)&&debit>1,message:`Seamless returned ${ids.length} request IDs for one submitted LinkedIn profile. Beast will not continue automatically.`};await this.store.saveResearch(key,next);return next}
      const next={...claim,status:'processing',requestIds:[ids[0]],updatedAt:Date.now(),afterCredits,afterCreditsObservedAt:response.observedAt,creditDelta:debit,creditAnomaly:Number.isFinite(debit)&&debit>1};await this.store.saveResearch(key,next);return next;
    }catch(error){return this.handleSubmissionError(key,claim,error)}
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
      let freshCredits=response.creditsRemaining??null,freshObservedAt=response.observedAt;try{const fresh=await rest.getCredits();if(Number.isFinite(fresh.creditsRemaining)){freshCredits=fresh.creditsRemaining;freshObservedAt=fresh.observedAt}}catch{}
      const debit=creditDelta(job.beforeCredits,freshCredits);const next={...job,status:'done',providerStatus,data,companyCheck:companyCheck(data,job.targetCompany),updatedAt:Date.now(),afterCredits:freshCredits,afterCreditsObservedAt:freshObservedAt,creditDelta:debit,creditAnomaly:Number.isFinite(debit)&&debit>1};await this.store.saveResearch(key,next);return next;
    }
    if(providerStatus==='missing'||providerStatus==='error'){
      const next={...job,status:providerStatus==='missing'?'missing':'failed',providerStatus,updatedAt:Date.now(),message:row.message||`Seamless research ${providerStatus}.`};await this.store.saveResearch(key,next);return next
    }
    return{...job,providerStatus:providerStatus||job.providerStatus,afterCredits:response.creditsRemaining??job.afterCredits,afterCreditsObservedAt:response.observedAt}
  }
  async ready(){await this.store.ready();if(this.pool&&this.pool.requireUniqueEgress)await this.pool.assertUniqueEgress()}
  async status(){
    const result={architecture:'exact-linkedin-single-research',keySource:this.keySource,database:{status:'ERROR'},seamless:{status:'CONFIGURED',transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxAutomaticResearchSubmissions:1},credits:null};
    try{await this.store.ready();result.database={status:'READY'}}catch(error){result.database={status:'ERROR',error:error.message}}
    try{
      if(this.pool){const provider=await this.pool.status();result.seamless={status:provider.status,transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxAutomaticResearchSubmissions:1,organizationCount:provider.organizationCount,uniqueEgressRequired:provider.uniqueEgressRequired,uniqueEgressVerified:provider.uniqueEgressVerified,error:provider.error};result.credits=provider}
      else{const credits=await this.rest.getCredits();result.seamless={status:'READY',transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxAutomaticResearchSubmissions:1,organizationCount:1,uniqueEgressRequired:false,uniqueEgressVerified:true};result.credits={status:'READY',organizationCount:1,totalCreditsRemaining:credits.creditsRemaining,routes:[{id:'injected',keySource:'injected',status:'READY',creditsRemaining:credits.creditsRemaining,observedAt:credits.observedAt,proxyConfigured:false}]}}
    }catch(error){result.seamless={status:'ERROR',transport:'REST direct LinkedIn research',mcpRequired:false,contactSearchDisabled:true,maxAutomaticResearchSubmissions:1,error:error.message}}
    return result
  }
}
module.exports={EnrichmentService,researchKey,parseContact,companyCheck,companiesMatch,creditDelta};
