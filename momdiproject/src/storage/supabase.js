'use strict';
class SupabaseStore{
  constructor(url=(process.env.SUPABASE_URL||'').trim(),apiKey=(process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim(),fetchImpl=globalThis.fetch){if(!url)throw new Error('Missing required secret SUPABASE_URL');if(!apiKey)throw new Error('Missing required secret SUPABASE_SECRET_KEY');this.baseUrl=url.replace(/\/$/,'')+'/rest/v1';this.apiKey=apiKey;this.fetch=fetchImpl}
  headers(extra={}){return{apikey:this.apiKey,Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json',...extra}}
  async request(table,query,method='GET',body,prefer){const response=await this.fetch(`${this.baseUrl}/${table}?${new URLSearchParams(query)}`,{method,headers:this.headers(prefer?{Prefer:prefer}:{}),body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!response.ok){const text=await response.text().catch(()=>'');throw new Error(`Supabase ${table} ${method} failed (${response.status}). Apply supabase/schema.sql and verify server credentials.${text?` ${text.slice(0,160)}`:''}`)}return response}
  async ready(){await this.request('person_searches',{select:'normalized_url',limit:'0'});await this.request('contact_research',{select:'search_result_id',limit:'0'})}
  async ensurePerson(url){const payload={mode:'exact-linkedin-single-research',person:{linkedinUrl:url},updatedAt:new Date().toISOString()};await this.request('person_searches',{on_conflict:'normalized_url'},'POST',{normalized_url:url,payload,updated_at:new Date().toISOString()},'resolution=merge-duplicates,return=minimal')}
  async getResearch(id){const r=await this.request('contact_research',{select:'payload',search_result_id:`eq.${id}`,limit:'1'});return (await r.json())[0]?.payload??null}
  async researchForPerson(url){const r=await this.request('contact_research',{select:'payload',normalized_url:`eq.${url}`});return (await r.json()).map(row=>row.payload)}
  async claimResearch(id,url,payload){const r=await this.request('contact_research',{on_conflict:'search_result_id'},'POST',{search_result_id:id,normalized_url:url,payload},'resolution=ignore-duplicates,return=representation');return (await r.json()).length===1}
  async saveResearch(id,payload){const r=await this.request('contact_research',{search_result_id:`eq.${id}`},'PATCH',{payload,updated_at:new Date().toISOString()},'return=representation');if(!(await r.json()).length)throw new Error('Research record missing; no new provider request was submitted.')}
  async deleteResearch(id){await this.request('contact_research',{search_result_id:`eq.${id}`},'DELETE',undefined,'return=minimal')}
}
module.exports={SupabaseStore};
