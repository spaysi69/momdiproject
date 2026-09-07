import test from 'node:test';
import assert from 'node:assert/strict';
import {SeamlessMcpClient,readRpcResponse} from '../dist/src/mcp/seamlessMcp.js';
import {parseMcpContacts,parseResearchResponse,searchPersonByLinkedIn} from '../dist/src/http/mcpPerson.js';
import {EnrichmentService} from '../dist/src/http/enrichment.js';
const normalized=data=>({structured:[data],text:[],raw:data});
const URL='https://www.linkedin.com/in/alex/';
class MemoryStore {
  searches=new Map([[URL,{person:{name:'Alex',linkedinUrl:URL},companies:['exact','a','b','x','instant'].map(searchResultId=>({searchResultId,fullName:'Alex',company:searchResultId}))}]]);
  jobs=new Map();
  async getSearch(url){return this.searches.get(url)||null}
  async saveSearch(url,payload){this.searches.set(url,structuredClone(payload))}
  async getResearch(id){return this.jobs.has(id)?structuredClone(this.jobs.get(id)):null}
  async researchForPerson(url){return [...this.jobs.values()].filter(j=>j.linkedinUrl===url).map(j=>structuredClone(j))}
  async claimResearch(id,url,payload){if(this.jobs.has(id))return false;this.jobs.set(id,structuredClone(payload));return true}
  async saveResearch(id,payload){this.jobs.set(id,structuredClone(payload))}
  async ready(){}
}
const config={cacheTtlSeconds:86400,requestTimeoutMs:1000,maxPolls:2,pollIntervalMs:1};
function service(mcp,store=new MemoryStore()) {
  const client={normalizeToolResult:normalized,...mcp};
  return {service:new EnrichmentService(config,store,client),store,client};
}
test('scalar and array request IDs both survive extraction',()=>{assert.deepEqual(parseResearchResponse(normalized({requestId:'req-1'}),'').requestIds,['req-1']);assert.deepEqual(parseResearchResponse(normalized({requestIds:['r1','r2']}),'').requestIds,['r1','r2'])});
test('table parser preserves blank cells and human-readable ID headers',()=>{const result=parseMcpContacts({structured:[],text:['| Search Result ID | Full Name | Job Title | Company |\n| --- | --- | --- | --- |\n| exact-id | Alex Doe | | Acme |'],raw:{}},'');assert.equal(result[0].searchResultId,'exact-id');assert.equal(result[0].company,'Acme');assert.equal(result[0].title,undefined)});
test('search never invents identity from generic IDs',()=>{assert.deepEqual(parseMcpContacts(normalized({items:[{id:'unrelated',name:'Acme'}]}),''),[])});
test('search deduplicates exact provider IDs',()=>{assert.equal(parseMcpContacts(normalized([{searchResultId:'x',name:'A'},{searchResultId:'x',name:'A'}]),'').length,1)});
test('LinkedIn search refuses unadvertised filters without a provider search',async()=>{let calls=0;await assert.rejects(searchPersonByLinkedIn({listTools:async()=>[{name:'search_contacts',inputSchema:{properties:{fullname:{type:'array'}}}}],searchContacts:async()=>{calls++}},'https://www.linkedin.com/in/alex/'),/does not advertise/);assert.equal(calls,0)});
test('JSON-RPC rejects mismatched response IDs',async()=>{await assert.rejects(readRpcResponse(new Response(JSON.stringify({id:'wrong',result:{}})),'right'),/mismatch/)});
test('SSE skips notifications and returns matching response',async()=>{const response=new Response('data: {"method":"notifications/progress"}\n\ndata: {"id":"a","result":{"ok":true}}\n\n',{headers:{'Content-Type':'text/event-stream'}});assert.equal((await readRpcResponse(response,'a')).result.ok,true)});
test('concurrent research submits a single paid request and caches completed result',async()=>{let paid=0;const {service:s}=service({researchContacts:async()=>{paid++;await new Promise(r=>setTimeout(r,15));return {requestId:'req'}},pollContactResearch:async()=>({status:'completed',contact:{fullName:'Alex Doe',email:'alex@example.com'}})});const input={searchResultId:'exact',linkedinUrl:URL};await Promise.all([s.startResearch(input),s.startResearch(input)]);assert.equal(paid,1);assert.equal((await s.pollResearch('exact')).status,'done');const cached=await s.startResearch(input);assert.equal(cached.status,'done');assert.equal(cached.data.email,'alex@example.com');assert.equal(paid,1)});
test('different company records for the same person keep independent jobs',async()=>{let count=0;const {service:s}=service({researchContacts:async()=>({requestId:`r${++count}`})});await s.startResearch({searchResultId:'a',linkedinUrl:'https://www.linkedin.com/in/alex/'});await s.startResearch({searchResultId:'b',linkedinUrl:'https://www.linkedin.com/in/alex/'});assert.equal(count,2)});
test('ambiguous timeout blocks automatic paid resubmission',async()=>{let paid=0;const {service:s}=service({researchContacts:async()=>{paid++;throw new Error('timeout')}});await assert.rejects(s.startResearch({searchResultId:'x',linkedinUrl:URL}),/timeout/);const retry=await s.startResearch({searchResultId:'x',linkedinUrl:URL});assert.equal(retry.status,'needs_review');assert.equal(paid,1)});
test('immediate completed research does not require a request ID',async()=>{const {service:s}=service({researchContacts:async()=>({status:'completed',contact:{fullName:'Alex',email:'alex@example.com'}})});assert.equal((await s.startResearch({searchResultId:'instant',linkedinUrl:URL})).status,'done')});
test('MCP client sends Token and accepts JSON plus SSE',async()=>{const original=globalThis.fetch;globalThis.fetch=async(_url,options)=>{assert.equal(options.headers.Token,'test');assert.match(options.headers.Accept,/text\/event-stream/);return new Response(JSON.stringify({id:JSON.parse(options.body).id,result:{content:[]}}))};try{await new SeamlessMcpClient('test').getCredits()}finally{globalThis.fetch=original}});

test('saved profile comes from Supabase without any MCP call',async()=>{
 const {service:s}=service({searchContacts:async()=>{throw Error('Must not search')},listTools:async()=>{throw Error('Must not list')}});
 const result=await s.searchPerson('https://linkedin.com/in/alex/?trk=abc');
 assert.equal(result.source,'supabase');assert.equal(result.companies.length,5);
});
test('first lookup persists every company; repeat lookup is database-only',async()=>{
 let searches=0,paid=0;const store=new MemoryStore();store.searches.clear();
 const {service:s}=service({listTools:async()=>[{name:'search_contacts',inputSchema:{properties:{linkedinUrl:{type:'array'}}}}],
 searchContacts:async()=>{searches++;return [{searchResultId:'a',fullName:'Alex',company:'One'},{searchResultId:'b',fullName:'Alex',company:'Two'}]},researchContacts:async()=>{paid++}},store);
 assert.equal((await s.searchPerson(URL)).companies.length,2);
 assert.equal((await s.searchPerson(URL)).source,'supabase');assert.equal(searches,1);assert.equal(paid,0);
});
test('enriched company remains available after a new service instance',async()=>{
 let paid=0;const {service:s,store,client}=service({researchContacts:async()=>{paid++;return {status:'done',contact:{fullName:'Alex',email:'a@one.example'}}}});
 await s.startResearch({linkedinUrl:URL,searchResultId:'a'});
 const restarted=new EnrichmentService(config,store,client);
 const found=await restarted.searchPerson(URL);
 assert.equal(found.companies.find(c=>c.searchResultId==='a').research.data.email,'a@one.example');
 assert.equal(found.companies.find(c=>c.searchResultId==='b').research,null);
 await restarted.startResearch({linkedinUrl:URL,searchResultId:'a'});assert.equal(paid,1);
});
test('database failure never falls back to a new provider search',async()=>{
 let calls=0;const store=new MemoryStore();store.getSearch=async()=>{throw Error('database offline')};
 const {service:s}=service({searchContacts:async()=>{calls++}},store);
 await assert.rejects(s.searchPerson(URL),/database offline/);assert.equal(calls,0);
});
test('arbitrary company IDs cannot trigger enrichment',async()=>{
 let calls=0;const {service:s}=service({researchContacts:async()=>{calls++}});
 await assert.rejects(s.startResearch({linkedinUrl:URL,searchResultId:'not-in-search'}),/does not belong/);assert.equal(calls,0);
});
test('a failed completion write cannot trigger a second paid submission',async()=>{
 let paid=0;const store=new MemoryStore();store.saveResearch=async()=>{throw Error('write unavailable')};
 const {service:s}=service({researchContacts:async()=>{paid++;return {status:'done',contact:{fullName:'Alex',email:'a@example.com'}}}},store);
 await assert.rejects(s.startResearch({linkedinUrl:URL,searchResultId:'a'}),/write unavailable/);
 const retry=await s.startResearch({linkedinUrl:URL,searchResultId:'a'});assert.equal(retry.status,'submitting');assert.equal(paid,1);
});
