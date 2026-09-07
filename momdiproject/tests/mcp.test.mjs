import test from 'node:test';
import assert from 'node:assert/strict';
import {SeamlessMcpClient,readRpcResponse} from '../dist/src/mcp/seamlessMcp.js';
import {parseMcpContacts,parseResearchResponse,searchPersonByLinkedIn} from '../dist/src/http/mcpPerson.js';
import {EnrichmentService} from '../dist/src/http/enrichment.js';
const normalized=data=>({structured:[data],text:[],raw:data});
class MemoryRedis {
  data=new Map();
  async get(k){return this.data.get(k)||null}
  async set(k,v,...args){if(args.includes('NX')&&this.data.has(k))return null;this.data.set(k,v);return 'OK'}
  async del(k){this.data.delete(k)}
  async ping(){return 'PONG'}
}
function service(mcp){process.env.SEAMLESS_MCP_API_KEY='test-only';delete process.env.SUPABASE_URL;const redis=new MemoryRedis();const service=new EnrichmentService({cacheTtlSeconds:86400,requestTimeoutMs:1000,maxPolls:2,pollIntervalMs:1},redis);service.mcp={normalizeToolResult:normalized,...mcp};return {service,redis}}
test('scalar and array request IDs both survive extraction',()=>{assert.deepEqual(parseResearchResponse(normalized({requestId:'req-1'}),'').requestIds,['req-1']);assert.deepEqual(parseResearchResponse(normalized({requestIds:['r1','r2']}),'').requestIds,['r1','r2'])});
test('table parser preserves blank cells and human-readable ID headers',()=>{const result=parseMcpContacts({structured:[],text:['| Search Result ID | Full Name | Job Title | Company |\n| --- | --- | --- | --- |\n| exact-id | Alex Doe | | Acme |'],raw:{}},'');assert.equal(result[0].searchResultId,'exact-id');assert.equal(result[0].company,'Acme');assert.equal(result[0].title,undefined)});
test('search never invents identity from generic IDs',()=>{assert.deepEqual(parseMcpContacts(normalized({items:[{id:'unrelated',name:'Acme'}]}),''),[])});
test('search deduplicates exact provider IDs',()=>{assert.equal(parseMcpContacts(normalized([{searchResultId:'x',name:'A'},{searchResultId:'x',name:'A'}]),'').length,1)});
test('LinkedIn search refuses unadvertised filters without a provider search',async()=>{let calls=0;await assert.rejects(searchPersonByLinkedIn({listTools:async()=>[{name:'search_contacts',inputSchema:{properties:{fullname:{type:'array'}}}}],searchContacts:async()=>{calls++}},'https://www.linkedin.com/in/alex/'),/does not advertise/);assert.equal(calls,0)});
test('JSON-RPC rejects mismatched response IDs',async()=>{await assert.rejects(readRpcResponse(new Response(JSON.stringify({id:'wrong',result:{}})),'right'),/mismatch/)});
test('SSE skips notifications and returns matching response',async()=>{const response=new Response('data: {"method":"notifications/progress"}\n\ndata: {"id":"a","result":{"ok":true}}\n\n',{headers:{'Content-Type':'text/event-stream'}});assert.equal((await readRpcResponse(response,'a')).result.ok,true)});
test('concurrent research submits a single paid request and caches completed result',async()=>{let paid=0;const {service:s}=service({researchContacts:async()=>{paid++;await new Promise(r=>setTimeout(r,15));return {requestId:'req'}},pollContactResearch:async()=>({status:'completed',contact:{fullName:'Alex Doe',email:'alex@example.com'}})});const input={searchResultId:'exact',linkedinUrl:''};await Promise.all([s.startResearch(input),s.startResearch(input)]);assert.equal(paid,1);assert.equal((await s.pollResearch('exact')).status,'done');const cached=await s.startResearch(input);assert.equal(cached.status,'done');assert.equal(cached.data.email,'alex@example.com');assert.equal(paid,1)});
test('different company records for the same person keep independent jobs',async()=>{let count=0;const {service:s}=service({researchContacts:async()=>({requestId:`r${++count}`})});await s.startResearch({searchResultId:'a',linkedinUrl:'https://www.linkedin.com/in/alex/'});await s.startResearch({searchResultId:'b',linkedinUrl:'https://www.linkedin.com/in/alex/'});assert.equal(count,2)});
test('ambiguous timeout blocks automatic paid resubmission',async()=>{let paid=0;const {service:s}=service({researchContacts:async()=>{paid++;throw new Error('timeout')}});await assert.rejects(s.startResearch({searchResultId:'x',linkedinUrl:''}),/timeout/);const retry=await s.startResearch({searchResultId:'x',linkedinUrl:''});assert.equal(retry.status,'needs_review');assert.equal(paid,1)});
test('immediate completed research does not require a request ID',async()=>{const {service:s}=service({researchContacts:async()=>({status:'completed',contact:{fullName:'Alex',email:'alex@example.com'}})});assert.equal((await s.startResearch({searchResultId:'instant',linkedinUrl:''})).status,'done')});
test('MCP client sends Token and accepts JSON plus SSE',async()=>{const original=globalThis.fetch;globalThis.fetch=async(_url,options)=>{assert.equal(options.headers.Token,'test');assert.match(options.headers.Accept,/text\/event-stream/);return new Response(JSON.stringify({id:JSON.parse(options.body).id,result:{content:[]}}))};try{await new SeamlessMcpClient('test').getCredits()}finally{globalThis.fetch=original}});
