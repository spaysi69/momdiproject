'use strict';
const {logger}=require('../utils/logger');
const crypto=require('node:crypto');

const REDACT_KEYS=/^(authorization|token|apikey|api_key|apiKey|password|secret|client_secret|access_token)$/i;
function safeJson(value,depth=0){
  if(depth>8)return'[MAX_DEPTH]';
  if(value==null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='string')return value.length>50000?`${value.slice(0,50000)}…[TRUNCATED]`:value;
  if(Array.isArray(value))return value.slice(0,200).map(v=>safeJson(v,depth+1));
  if(typeof value==='object'){
    const out={};
    for(const [k,v] of Object.entries(value))out[k]=REDACT_KEYS.test(k)?'[REDACTED]':safeJson(v,depth+1);
    return out;
  }
  return String(value);
}
function sanitizeHeaders(headers){
  const out={};
  try{for(const [k,v] of headers.entries()){const key=String(k).toLowerCase();if(['set-cookie','cookie','authorization','token'].includes(key))continue;out[key]=String(v)}}catch{}
  return out;
}
function parseRequestBody(body){if(body==null)return null;if(typeof body!=='string')return safeJson(body);try{return safeJson(JSON.parse(body))}catch{return String(body).slice(0,50000)}}
function diagnosticRecord({callId,routeId,keySource,path,method,requestBody,status,responseHeaders,responseBody,startedAt,observedAt,error=null}){
  return safeJson({
    step:'seamless_http',callId,routeId,keySource,startedAt,observedAt,
    request:{method,path,headers:{Accept:'application/json',Token:'[REDACTED]',...(requestBody!=null?{'Content-Type':'application/json'}:{})},body:requestBody},
    response:{status,headers:responseHeaders,body:responseBody},
    error
  });
}
class SeamlessRestError extends Error{constructor(status,code,message,details,creditsRemaining=null,diagnostic=null){super(message);this.name='SeamlessRestError';this.status=status;this.code=code;this.details=details;this.creditsRemaining=creditsRemaining;this.diagnostic=diagnostic}}
function numericHeader(headers,name){const raw=headers.get(name);if(raw==null||raw.trim()==='')return null;const v=Number(raw);return Number.isFinite(v)?v:null}
function classify(status,body){const code=typeof body?.code==='string'?body.code:`HTTP_${status}`;const raw=[body?.msg,body?.message,body?.error?.message,body?.error].find(v=>typeof v==='string'&&v.trim());if(code==='insufficientCredits')return{code,message:'Seamless reports insufficient Public API research credits.'};if(code==='missingLicense')return{code,message:'This Seamless connection does not have an active Public API license.'};if(status===401)return{code,message:'Seamless rejected the API key. Check the selected Render secret.'};if(status===403)return{code,message:'Seamless refused this API key. Check Public API v1 access and group permissions.'};if(status===429)return{code,message:'Seamless rate limit reached. Retry after the provider reset window.'};if(status===422&&raw)return{code,message:`Seamless rejected the request: ${String(raw).slice(0,240)}`};if(status>=500)return{code,message:`Seamless is temporarily unavailable (HTTP ${status}).`};return{code,message:raw?String(raw).slice(0,240):`Seamless request failed (HTTP ${status}).`}}
class SeamlessRestClient{
  constructor(apiKey,baseUrl='https://api.seamless.ai/api/client/v1',timeoutMs=30000,fetchImpl=null,options={}){if(!apiKey)throw new Error('Missing Seamless API key');this.apiKey=apiKey;this.baseUrl=baseUrl.replace(/\/$/,'');this.timeoutMs=timeoutMs;this.fetch=fetchImpl||fetch;this.routeId=options.routeId||'default';this.keySource=options.keySource||'SEAMLESS_API_KEY';this.onDiagnostic=typeof options.onDiagnostic==='function'?options.onDiagnostic:null}
  async request(path,init={}){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.timeoutMs);const startedAt=new Date().toISOString();const callId=crypto.randomUUID();const method=String(init.method||'GET').toUpperCase();const requestBody=parseRequestBody(init.body);
    try{
      const response=await this.fetch(this.baseUrl+path,{...init,headers:{Accept:'application/json',Token:this.apiKey,...(init.body?{'Content-Type':'application/json'}:{}),...(init.headers||{})},signal:controller.signal});
      const creditsRemaining=numericHeader(response.headers,'X-PublicAPI-Credits');const rateLimitRemaining=numericHeader(response.headers,'X-RateLimit-Remaining');const rateLimitReset=numericHeader(response.headers,'X-RateLimit-Reset');const text=await response.text();let body=null;if(text){try{body=JSON.parse(text)}catch{body={message:text.slice(0,50000)}}}
      const observedAt=new Date().toISOString();const diagnostic=diagnosticRecord({callId,routeId:this.routeId,keySource:this.keySource,path,method,requestBody,status:response.status,responseHeaders:sanitizeHeaders(response.headers),responseBody:safeJson(body),startedAt,observedAt});try{this.onDiagnostic?.(diagnostic)}catch{}
      if(!response.ok){const c=classify(response.status,body);throw new SeamlessRestError(response.status,c.code,c.message,body?.data,creditsRemaining,diagnostic)}
      return{data:body,creditsRemaining,rateLimitRemaining,rateLimitReset,observedAt,routeId:this.routeId,keySource:this.keySource,diagnostic};
    }catch(error){
      if(error?.name==='AbortError'){
        const observedAt=new Date().toISOString();const diagnostic=diagnosticRecord({callId,routeId:this.routeId,keySource:this.keySource,path,method,requestBody,status:null,responseHeaders:{},responseBody:null,startedAt,observedAt,error:`Timeout after ${this.timeoutMs}ms`});try{this.onDiagnostic?.(diagnostic)}catch{}
        throw new SeamlessRestError(504,'TIMEOUT',`Seamless REST request timed out after ${this.timeoutMs}ms.`,null,null,diagnostic);
      }
      if(!(error instanceof SeamlessRestError))logger.warn('seamless.rest.request_failed',{path,routeId:this.routeId,message:error?.message||String(error)});throw error;
    }finally{clearTimeout(timer)}
  }
  researchLinkedIn(linkedinUrl){return this.request('/contacts/research',{method:'POST',body:JSON.stringify({contacts:[{liProfileUrl:linkedinUrl}],skipDeduplicationCheck:false})})}
  pollContactResearch(requestIds){return this.request(`/contacts/research/poll?${new URLSearchParams({requestIds:requestIds.join(',')})}`,{method:'GET'})}
  async getCredits(){const end=new Date();const start=new Date(end.getTime()-1_000);const iso=d=>d.toISOString().replace(/\.\d{3}Z$/,'Z');const qs=new URLSearchParams({page:'1',limit:'1',startDate:iso(start),endDate:iso(end)});const r=await this.request(`/contacts?${qs}`,{method:'GET'});return{creditsRemaining:r.creditsRemaining,rateLimitRemaining:r.rateLimitRemaining,rateLimitReset:r.rateLimitReset,observedAt:r.observedAt,routeId:this.routeId,keySource:this.keySource,diagnostic:r.diagnostic}}
}
module.exports={SeamlessRestClient,SeamlessRestError,numericHeader,safeJson,sanitizeHeaders};
