'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {normalizeLinkedInUrl}=require('../src/utils/normalizeUrl');
const {SeamlessRestClient,SeamlessRestError}=require('../src/seamless/restClient');
const {EnrichmentService,researchKey,parseContact,companyCheck,normalizePhone,selectContactPhones,buildContactMethods}=require('../src/http/enrichment');
const {SeamlessRoutePool}=require('../src/seamless/routePool');
const {seamlessCredentials}=require('../src/config/credentials');
const {createHandler}=require('../src/server/app');

const cfg={apiBaseUrl:'https://api.seamless.ai/api/client/v1',requestTimeoutMs:30000,pollIntervalMs:2500,maxPolls:30};
class MemoryStore{
  constructor(){this.people=new Set();this.jobs=new Map()}
  async ready(){}
  async ensurePerson(url){this.people.add(url)}
  async getResearch(id){return this.jobs.get(id)||null}
  async researchForPerson(url){return [...this.jobs.values()].filter(x=>x.normalizedUrl===url)}
  async claimResearch(id,url,payload){if(this.jobs.has(id))return false;this.jobs.set(id,{...payload});return true}
  async saveResearch(id,payload){if(!this.jobs.has(id))throw new Error('missing');this.jobs.set(id,{...payload})}
  async deleteResearch(id){this.jobs.delete(id)}
}
function response(body,status=200,headers={}){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}})}

test('normalizes exact LinkedIn person URLs',()=>{assert.equal(normalizeLinkedInUrl('https://linkedin.com/in/Jane-Smith?trk=x'),'https://www.linkedin.com/in/Jane-Smith/');assert.throws(()=>normalizeLinkedInUrl('https://linkedin.com/company/acme'),/LinkedIn/)});

test('direct research submits exactly one liProfileUrl and keeps deduplication enabled',async()=>{let seen;const client=new SeamlessRestClient('key',cfg.apiBaseUrl,30000,async(url,init)=>{seen={url,init};return response({success:true,requestIds:['req1']},202,{'X-PublicAPI-Credits':'9'})});await client.researchLinkedIn('https://www.linkedin.com/in/jane/');assert.match(seen.url,/\/contacts\/research$/);assert.equal(seen.init.headers.Token,'key');const body=JSON.parse(seen.init.body);assert.deepEqual(body,{contacts:[{liProfileUrl:'https://www.linkedin.com/in/jane/'}],skipDeduplicationCheck:false});assert.equal(body.contacts.length,1)});

test('lookup is provider-free: cache check only and no Seamless call',async()=>{const store=new MemoryStore();let calls=0;const rest={getCredits:async()=>{calls++;return{creditsRemaining:10}},researchLinkedIn:async()=>{calls++;throw Error('not expected')}};const svc=new EnrichmentService(cfg,store,rest);const r=await svc.lookup('https://www.linkedin.com/in/jane-smith/','Acme');assert.equal(r.readyToResearch,true);assert.equal(r.researchPlan.contacts,1);assert.equal(r.researchPlan.searchEndpointsUsed,false);assert.equal(calls,0)});

test('cached lookup returns contact without any provider request',async()=>{const store=new MemoryStore(),url=normalizeLinkedInUrl('https://linkedin.com/in/jane/'),key=researchKey(url);store.jobs.set(key,{status:'done',normalizedUrl:url,data:{fullName:'Jane',company:'Acme',jobHistory:[]}});let calls=0;const svc=new EnrichmentService(cfg,store,{getCredits:async()=>{calls++;return{creditsRemaining:9}}});const r=await svc.lookup(url,'Acme');assert.equal(r.cached,true);assert.equal(r.job.companyCheck.status,'current');assert.equal(calls,0)});

test('one enrichment action creates only one provider research submission',async()=>{const store=new MemoryStore();let researchCalls=0;const rest={getCredits:async()=>({creditsRemaining:10,observedAt:'before'}),researchLinkedIn:async url=>{researchCalls++;assert.equal(url,'https://www.linkedin.com/in/jane/');return{creditsRemaining:9,observedAt:'after',data:{requestIds:['req1']}}}};const svc=new EnrichmentService(cfg,store,rest);const r=await svc.startResearch({linkedinUrl:'https://www.linkedin.com/in/jane/',targetCompany:'Acme'});assert.equal(researchCalls,1);assert.equal(r.requestIds.length,1);assert.equal(r.creditDelta,1);assert.equal(r.submittedContacts,1);assert.equal(r.maxChargeableSubmissions,1)});

test('concurrent clicks cannot submit the same LinkedIn profile twice',async()=>{const store=new MemoryStore();let calls=0;const rest={getCredits:async()=>({creditsRemaining:10}),researchLinkedIn:async()=>{calls++;await new Promise(r=>setTimeout(r,20));return{creditsRemaining:9,data:{requestIds:['req']}}}};const svc=new EnrichmentService(cfg,store,rest);const [a,b]=await Promise.all([svc.startResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'}),svc.startResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'})]);assert.equal(calls,1);assert.ok(['submitting','processing'].includes(a.status));assert.ok(['submitting','processing'].includes(b.status))});

test('ambiguous transport failure is never automatically resubmitted',async()=>{const store=new MemoryStore();let calls=0;const rest={getCredits:async()=>({creditsRemaining:10}),researchLinkedIn:async()=>{calls++;throw new Error('socket reset after send')}};const svc=new EnrichmentService(cfg,store,rest);await assert.rejects(()=>svc.startResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'}),/socket reset/);const saved=await store.getResearch(researchKey('https://www.linkedin.com/in/jane/'));assert.equal(saved.status,'needs_review');await svc.startResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'});assert.equal(calls,1)});

test('unexpected multiple request IDs are quarantined instead of polled automatically',async()=>{const store=new MemoryStore();const rest={getCredits:async()=>({creditsRemaining:10}),researchLinkedIn:async()=>({creditsRemaining:8,data:{requestIds:['a','b']}})};const svc=new EnrichmentService(cfg,store,rest);const r=await svc.startResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'});assert.equal(r.status,'needs_review');assert.match(r.message,/2 request IDs/);assert.equal(r.creditAnomaly,true)});

test('poll parses current company and job history and measures one-credit delta',async()=>{const store=new MemoryStore(),url='https://www.linkedin.com/in/jane/';let creditCalls=0;const rest={getCredits:async()=>({creditsRemaining:creditCalls++===0?10:9,observedAt:'fresh'}),researchLinkedIn:async()=>({creditsRemaining:9,observedAt:'accepted',data:{requestIds:['req']}}),pollContactResearch:async ids=>{assert.deepEqual(ids,['req']);return{creditsRemaining:9,observedAt:'poll',data:{data:[{requestId:'req',status:'done',contact:{fullName:'Jane Smith',email:'jane@newco.com',company:'NewCo',title:'VP Sales',lIProfileUrl:url,formerCompany:'Acme',formerTitle:'Sales Director',jobHistory:[{companyName:'Acme',title:'Sales Director',startedAt:'2020-01-01T00:00:00Z',endedAt:'2024-01-01T00:00:00Z'}]}}]}}}};const svc=new EnrichmentService(cfg,store,rest);await svc.startResearch({linkedinUrl:url,targetCompany:'Acme'});const r=await svc.pollResearch({linkedinUrl:url});assert.equal(r.status,'done');assert.equal(r.data.company,'NewCo');assert.equal(r.companyCheck.status,'former');assert.equal(r.creditDelta,1);assert.equal(r.data.jobHistory[0].companyName,'Acme')});

test('target company check distinguishes current, former, and mismatch',()=>{const d={company:'NewCo',jobHistory:[{companyName:'Acme',title:'Director'}]};assert.equal(companyCheck(d,'NewCo').status,'current');assert.equal(companyCheck(d,'Acme').status,'former');assert.equal(companyCheck(d,'Other Corp').status,'mismatch')});

test('duplicate poll with returned contact is saved as done without a new submit',async()=>{const store=new MemoryStore(),url='https://www.linkedin.com/in/jane/';let submit=0;const rest={getCredits:async()=>({creditsRemaining:10}),researchLinkedIn:async()=>{submit++;return{creditsRemaining:10,data:{requestIds:['req']}}},pollContactResearch:async()=>({creditsRemaining:10,data:{data:[{requestId:'req',status:'duplicate',contact:{fullName:'Jane',company:'Acme',lIProfileUrl:url}}]}})};const svc=new EnrichmentService(cfg,store,rest);await svc.startResearch({linkedinUrl:url});const r=await svc.pollResearch({linkedinUrl:url});assert.equal(r.status,'done');assert.equal(r.providerStatus,'duplicate');assert.equal(submit,1)});

test('credit anomaly is explicit if provider balance drops by more than one',async()=>{const store=new MemoryStore();let creditCalls=0;const rest={getCredits:async()=>({creditsRemaining:creditCalls++===0?100:71}),researchLinkedIn:async()=>({creditsRemaining:71,data:{requestIds:['req']}}),pollContactResearch:async()=>({creditsRemaining:71,data:{data:[{requestId:'req',status:'done',contact:{fullName:'Jane',company:'Acme'}}]}})};const svc=new EnrichmentService(cfg,store,rest);const started=await svc.startResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'});assert.equal(started.creditDelta,29);assert.equal(started.creditAnomaly,true);const done=await svc.pollResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'});assert.equal(done.creditAnomaly,true);assert.equal(done.creditDelta,29)});

test('multi-org research uses PRIMARY even when SECONDARY has more credits and pins polling to PRIMARY',async()=>{const store=new MemoryStore();let pSubmit=0,pPoll=0,sSubmit=0;const primary={getCredits:async()=>({creditsRemaining:3,observedAt:'p'}),researchLinkedIn:async()=>{pSubmit++;return{creditsRemaining:2,data:{requestIds:['preq']}}},pollContactResearch:async()=>{pPoll++;return{creditsRemaining:2,data:{data:[{requestId:'preq',status:'done',contact:{fullName:'Jane',company:'Acme'}}]}}},};const secondary={getCredits:async()=>({creditsRemaining:20,observedAt:'s'}),researchLinkedIn:async()=>{sSubmit++;throw Error('secondary should stay standby')},};const env={SEAMLESS_API_KEY_PRIMARY:'p',SEAMLESS_API_KEY_SECONDARY:'s'};const pool=new SeamlessRoutePool(cfg,env,route=>route.id==='primary'?primary:secondary);const svc=new EnrichmentService(cfg,store,null,pool);const started=await svc.startResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'});assert.equal(started.routeId,'primary');assert.equal(pSubmit,1);assert.equal(sSubmit,0);await svc.pollResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'});assert.equal(pPoll,1);assert.equal(sSubmit,0)});

test('status declares exact single-research architecture with contact search disabled',async()=>{const store=new MemoryStore();const svc=new EnrichmentService(cfg,store,{getCredits:async()=>({creditsRemaining:44,observedAt:'now'})});const r=await svc.status();assert.equal(r.architecture,'exact-linkedin-one-page-priority-failover');assert.equal(r.seamless.contactSearchDisabled,true);assert.equal(r.seamless.mcpRequired,false);assert.equal(r.seamless.maxChargeableSubmissions,1)});



test('fresh credit totals never substitute a stale previous balance',async()=>{let calls=0;const pool=new SeamlessRoutePool(cfg,{SEAMLESS_API_KEY_PRIMARY:'p'},()=>({getCredits:async()=>{calls++;return calls===1?{creditsRemaining:12,observedAt:'first'}:{creditsRemaining:null,observedAt:'second'}}}));assert.equal((await pool.status()).totalCreditsRemaining,12);const second=await pool.status();assert.equal(second.totalCreditsRemaining,null);assert.equal(second.routes[0].lastKnownCreditsRemaining,12)});

test('HTTP research accepts target company but exposes no searchResultId flow',async()=>{let input;const fake={lookup:async(u,t)=>({linkedinUrl:u,targetCompany:t,readyToResearch:true}),startResearch:async i=>(input=i,{status:'processing'}),pollResearch:async()=>({status:'done'}),status:async()=>({database:{status:'READY'},seamless:{status:'READY'}}),ready:async()=>{}};const old=process.env.APP_AUTH_TOKEN;process.env.APP_AUTH_TOKEN='pw';const server=http.createServer(createHandler(fake));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;try{const res=await fetch(base+'/v1/person/research',{method:'POST',headers:{Authorization:'Bearer pw','Content-Type':'application/json'},body:JSON.stringify({linkedinUrl:'https://www.linkedin.com/in/jane/',targetCompany:'Acme',searchResultId:'should-be-ignored'})});assert.equal(res.status,202);assert.equal(input.targetCompany,'Acme');assert.equal(Object.hasOwn(input,'searchResultId'),false)}finally{await new Promise(r=>server.close(r));if(old===undefined)delete process.env.APP_AUTH_TOKEN;else process.env.APP_AUTH_TOKEN=old}});

test('production runtime contains no contact search or MCP client',()=>{const files=['../src/http/enrichment.js','../src/seamless/restClient.js','../src/seamless/routePool.js','../src/server/app.js'];const joined=files.map(f=>fs.readFileSync(path.join(__dirname,f),'utf8')).join('\n');assert.equal(joined.includes('/search/contacts'),false);assert.equal(joined.includes('search_contacts'),false);assert.equal(joined.includes('McpClient'),false);assert.equal(fs.existsSync(path.join(__dirname,'../src/seamless/mcpClient.js')),false)});


test('PRIMARY then SECONDARY credential order is deterministic',()=>{const r=seamlessCredentials({SEAMLESS_API_KEY_SECONDARY:'s',SEAMLESS_API_KEY_PRIMARY:'p',SEAMLESS_API_KEY:'legacy'});assert.deepEqual(r.routes.map(x=>x.id),['primary','secondary','default'])});

test('route pool switches to SECONDARY only when PRIMARY reports zero credits',async()=>{const env={SEAMLESS_API_KEY_PRIMARY:'p',SEAMLESS_API_KEY_SECONDARY:'s'};const clients={primary:{getCredits:async()=>({creditsRemaining:0,observedAt:'p'}),},secondary:{getCredits:async()=>({creditsRemaining:41,observedAt:'s'}),}};const pool=new SeamlessRoutePool(cfg,env,route=>clients[route.id]);const chosen=await pool.chooseResearchRoute();assert.equal(chosen.id,'secondary')});


test('explicit insufficientCredits on PRIMARY may safely fail over once to SECONDARY',async()=>{const store=new MemoryStore();let pSubmit=0,sSubmit=0;const primary={getCredits:async()=>({creditsRemaining:1,observedAt:'p'}),researchLinkedIn:async()=>{pSubmit++;throw new SeamlessRestError(422,'insufficientCredits','no credits')},};const secondary={getCredits:async()=>({creditsRemaining:41,observedAt:'s'}),researchLinkedIn:async()=>{sSubmit++;return{creditsRemaining:40,observedAt:'s2',data:{requestIds:['sreq']}}},};const env={SEAMLESS_API_KEY_PRIMARY:'p',SEAMLESS_API_KEY_SECONDARY:'s'};const pool=new SeamlessRoutePool(cfg,env,route=>route.id==='primary'?primary:secondary);const svc=new EnrichmentService(cfg,store,null,pool);const result=await svc.startResearch({linkedinUrl:'https://www.linkedin.com/in/jane/'});assert.equal(pSubmit,1);assert.equal(sSubmit,1);assert.equal(result.routeId,'secondary');assert.equal(result.failoverFrom,'primary');assert.equal(result.safeFailoverReason.includes('insufficientCredits'),true)});

test('status labels PRIMARY active and SECONDARY standby while PRIMARY has credits',async()=>{const env={SEAMLESS_API_KEY_PRIMARY:'p',SEAMLESS_API_KEY_SECONDARY:'s'};const clients={primary:{getCredits:async()=>({creditsRemaining:44,observedAt:'p'}),},secondary:{getCredits:async()=>({creditsRemaining:41,observedAt:'s'}),}};const pool=new SeamlessRoutePool(cfg,env,route=>clients[route.id]);const st=await pool.status();assert.equal(st.activeRouteId,'primary');assert.equal(st.routes.find(x=>x.id==='primary').usageState,'ACTIVE');assert.equal(st.routes.find(x=>x.id==='secondary').usageState,'STANDBY')});

test('phone output is normalized to E.164-style +1 for US and Canadian numbers',()=>{assert.equal(normalizePhone('(415) 555-0101','US'),'+14155550101');assert.equal(normalizePhone('1-415-555-0102','CA'),'+14155550102');assert.equal(normalizePhone('+1 650 555 0200','US'),'+16505550200')});

test('parsed contact preserves company switchboard numbers with explicit current-company association',()=>{const d=parseContact({fullName:'Jane Smith',company:'Acme',companyDomain:'acme.com',email:'Jane@Acme.com',email1:'Jane@Acme.com',email2:'jane.personal@example.com',personalEmail:'jane.personal@example.com',contactPhone1:'415.555.0101',contactPhone1DataType:'mobile',contactPhone1TotalAI:'98%',contactPhone2:'+1 415 555 0101',contactPhone2DataType:'main',companyPhone1:'650-555-0200',contactLocation:{countryAbbr:'US'},companyLocation:{countryAbbr:'US'},jobHistory:[{companyName:'OldCo'}]},'https://www.linkedin.com/in/jane/');assert.deepEqual(d.phones,['+14155550101']);assert.equal(d.currentCompanyMethods.some(x=>x.value==='+16505550200'&&x.companyName==='Acme'),true);assert.equal(d.currentCompanyMethods.some(x=>x.value==='jane@acme.com'),true);assert.equal(d.personMethods.some(x=>x.value==='jane.personal@example.com'),true);assert.equal(d.hasMultipleCompanies,true)});

test('phone selector caps output at two person-level values and never includes companyPhone fields',()=>{const c={contactPhone1:'4155550101',contactPhone1DataType:'mobile',contactPhone1TotalAI:'90%',contactPhone2:'4155550102',contactPhone2DataType:'direct',contactPhone2TotalAI:'95%',companyPhone1:'6505550200',companyPhone2:'6505550201',contactLocation:{countryAbbr:'US'}};assert.deepEqual(selectContactPhones(c,'US'),['+14155550102','+14155550101'])});

test('main contact phone is a fallback when no direct or mobile number exists',()=>{const c={contactPhone1:'4155550101',contactPhone1DataType:'main',contactPhone1TotalAI:'99%'};assert.deepEqual(selectContactPhones(c,'US'),['+14155550101'])});


test('contact method classification never invents historical-company associations',()=>{const methods=buildContactMethods({companyDomain:'newco.com',email1:'jane@newco.com',email2:'jane@oldco.com',personalEmail:'jane@gmail.com',contactPhone1:'4155550101',contactPhone1DataType:'mobile',companyPhone1:'6505550200',contactLocation:{countryAbbr:'US'},companyLocation:{countryAbbr:'US'}},'NewCo');const work=methods.find(x=>x.value==='jane@newco.com');const unknown=methods.find(x=>x.value==='jane@oldco.com');const personal=methods.find(x=>x.value==='jane@gmail.com');const companyPhone=methods.find(x=>x.value==='+16505550200');assert.equal(work.scope,'current_company');assert.equal(work.companyName,'NewCo');assert.equal(unknown.scope,'unassigned');assert.equal(unknown.companyName,null);assert.equal(personal.scope,'person');assert.equal(companyPhone.scope,'current_company');assert.equal(companyPhone.companyName,'NewCo')});

test('UI preserves current-company, personal and unassigned contact sections',()=>{const js=fs.readFileSync(path.join(__dirname,'../src/server/public/app.js'),'utf8');assert.match(js,/Current company/);assert.match(js,/Personal \/ direct/);assert.match(js,/company not confirmed/i);assert.match(js,/No company-specific contact mapping supplied by Seamless/)});
test('workspace has one-click enrichment and no confirmation modal',()=>{const html=fs.readFileSync(path.join(__dirname,'../src/server/public/chatbox.html'),'utf8');const js=fs.readFileSync(path.join(__dirname,'../src/server/public/app.js'),'utf8');assert.equal(html.includes('confirm-dialog'),false);assert.equal(js.includes('openConfirm'),false);assert.match(js,/chat-form.*enrich\(\)/s);assert.match(html,/>Enrich</)});

test('verified build fingerprint matches diagnostic source',()=>{const {sourceHash}=require('../scripts-build-info.cjs');const info=JSON.parse(fs.readFileSync(path.join(__dirname,'../dist/BUILD_INFO.json'),'utf8'));assert.equal(info.version,'40.1.0-test');assert.equal(info.sourceHash,sourceHash())});





test('credit probe uses required ISO8601 window and trusts provider credit header',async()=>{let seen;const client=new SeamlessRestClient('key',cfg.apiBaseUrl,30000,async(url,init)=>{seen={url,init};return response({data:[]},200,{'X-PublicAPI-Credits':'85'})});const r=await client.getCredits();const u=new URL(seen.url);assert.equal(u.pathname.endsWith('/contacts'),true);assert.match(u.searchParams.get('startDate'),/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);assert.match(u.searchParams.get('endDate'),/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);assert.equal(r.creditsRemaining,85)});

test('multi-org mode works without any proxy variables',()=>{const r=seamlessCredentials({SEAMLESS_API_KEY_PRIMARY:'p',SEAMLESS_API_KEY_SECONDARY:'s'});assert.deepEqual(r.routes.map(x=>x.id),['primary','secondary']);assert.ok(r.routes.every(x=>!Object.hasOwn(x,'proxyUrl')))});

test('combined credit total is shown only when every configured organization has a fresh header',async()=>{const env={SEAMLESS_API_KEY_PRIMARY:'p',SEAMLESS_API_KEY_SECONDARY:'s'};const clients={primary:{getCredits:async()=>({creditsRemaining:44,observedAt:'p'})},secondary:{getCredits:async()=>({creditsRemaining:null,observedAt:'s'})}};const pool=new SeamlessRoutePool(cfg,env,route=>clients[route.id]);const st=await pool.status();assert.equal(st.totalCreditsRemaining,null);assert.equal(st.allFresh,false);assert.equal(st.routes.find(x=>x.id==='primary').creditsRemaining,44);assert.equal(st.routes.find(x=>x.id==='secondary').creditsRemaining,null)});

test('combined credits sum fresh provider balances from both organizations',async()=>{const env={SEAMLESS_API_KEY_PRIMARY:'p',SEAMLESS_API_KEY_SECONDARY:'s'};const clients={primary:{getCredits:async()=>({creditsRemaining:44,observedAt:'p'})},secondary:{getCredits:async()=>({creditsRemaining:41,observedAt:'s'})}};const pool=new SeamlessRoutePool(cfg,env,route=>clients[route.id]);const st=await pool.status();assert.equal(st.totalCreditsRemaining,85);assert.equal(st.allFresh,true);assert.equal(st.balanceSource,'X-PublicAPI-Credits')});

test('v40 runtime has no egress or proxy requirement',()=>{const files=['../src/config/credentials.js','../src/seamless/routePool.js','../src/seamless/restClient.js','../src/server/public/app.js','../src/server/public/chatbox.html'];const joined=files.map(f=>fs.readFileSync(path.join(__dirname,f),'utf8')).join('\n');assert.equal(joined.includes('SEAMLESS_EGRESS'),false);assert.equal(joined.toLowerCase().includes('egress ip'),false);assert.equal(fs.existsSync(path.join(__dirname,'../src/seamless/proxyTransport.js')),false)});

test('v40 UI keeps results in a scroll-snap feed and appends new slides',()=>{const html=fs.readFileSync(path.join(__dirname,'../src/server/public/chatbox.html'),'utf8');const js=fs.readFileSync(path.join(__dirname,'../src/server/public/app.js'),'utf8');const css=fs.readFileSync(path.join(__dirname,'../src/server/public/app.css'),'utf8');assert.match(html,/id="result-feed"/);assert.match(js,/feed\.append\(slide\)/);assert.match(js,/scrollIntoView/);assert.match(css,/scroll-snap-type:y mandatory/);assert.match(css,/scroll-snap-align:start/)});

test('diagnostic build uses fresh Seamless header snapshots without background 10-second probing',()=>{const js=fs.readFileSync(path.join(__dirname,'../src/server/public/app.js'),'utf8');assert.match(js,/X-PublicAPI-Credits/);assert.match(js,/combined total withheld because every route is not fresh/);assert.match(js,/Local fallback<\/span><strong>Never used for displayed total/);assert.equal(/setInterval\(\(\)=>checkConnection\(\).*10000/s.test(js),false)});


test('diagnostic HTTP trace captures provider request and response while redacting API token',async()=>{
  let seenToken=null;
  const client=new SeamlessRestClient('super-secret-key',cfg.apiBaseUrl,30000,async(url,init)=>{seenToken=init.headers.Token;return response({success:true,requestIds:['req-diagnostic']},202,{'X-PublicAPI-Credits':'12','X-RateLimit-Remaining':'99','X-Request-Id':'provider-123'})});
  const r=await client.researchLinkedIn('https://www.linkedin.com/in/jane/');
  assert.equal(seenToken,'super-secret-key');
  assert.equal(r.diagnostic.request.headers.Token,'[REDACTED]');
  assert.equal(r.diagnostic.request.body.contacts.length,1);
  assert.equal(r.diagnostic.request.body.contacts[0].liProfileUrl,'https://www.linkedin.com/in/jane/');
  assert.equal(r.diagnostic.response.status,202);
  assert.equal(r.diagnostic.response.headers['x-publicapi-credits'],'12');
  assert.deepEqual(r.diagnostic.response.body.requestIds,['req-diagnostic']);
  assert.equal(JSON.stringify(r.diagnostic).includes('super-secret-key'),false);
});

test('diagnostic trace follows the same single enrichment without extra research submission',async()=>{
  const store=new MemoryStore(),url='https://www.linkedin.com/in/jane/';let submits=0,polls=0,creditReads=0;
  const diag=n=>({step:'seamless_http',request:{method:n==='research'?'POST':'GET',path:`/${n}`,headers:{Token:'[REDACTED]'}},response:{status:200,headers:{'x-publicapi-credits':'9'},body:{stage:n}}});
  const rest={
    getCredits:async()=>({creditsRemaining:creditReads++===0?10:9,observedAt:`credit-${creditReads}`,diagnostic:diag(creditReads===1?'preflight':'final-credit')}),
    researchLinkedIn:async()=>{submits++;return{creditsRemaining:9,observedAt:'accepted',diagnostic:diag('research'),data:{requestIds:['req']}}},
    pollContactResearch:async()=>{polls++;return{creditsRemaining:9,observedAt:'poll',diagnostic:diag('poll'),data:{data:[{requestId:'req',status:'done',contact:{fullName:'Jane',company:'Acme',email:'jane@acme.com'}}]}}}
  };
  const svc=new EnrichmentService(cfg,store,rest);
  await svc.startResearch({linkedinUrl:url});
  const done=await svc.pollResearch({linkedinUrl:url});
  assert.equal(submits,1);
  assert.equal(polls,1);
  assert.equal(done.status,'done');
  assert.deepEqual(done.diagnosticTrace.map(x=>x.response.body.stage),['preflight','research','poll','final-credit']);
});

test('diagnostic UI exposes a copyable provider report and warns that contact data is preserved',()=>{
  const js=fs.readFileSync(path.join(__dirname,'../src/server/public/app.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'../src/server/public/chatbox.html'),'utf8');
  assert.match(js,/Copy diagnostic report/);
  assert.match(js,/seamlessHttpTrace/);
  assert.match(js,/API\/auth secrets are redacted/);
  assert.match(html,/TEST TRACE/);
});
