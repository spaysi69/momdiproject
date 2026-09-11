'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {FLAGGED,NOT_FLAGGED,getRoles,publicRoleGroups}=require('../src/prospecting/roles');
const {ProspectingService,canonicalLinkedIn,aliasScore,makeQueries}=require('../src/prospecting/service');

test('prospecting ontology contains full flagged and not-flagged families',()=>{
  assert.equal(FLAGGED.length,12);assert.equal(NOT_FLAGGED.length,15);
  const groups=publicRoleGroups();assert.equal(groups.flagged[0].label,'IT Manager');assert.ok(groups.flagged.find(r=>r.label==='Cybersecurity Manager').aliases.includes('SOC Manager'));
  assert.ok(groups.not_flagged.find(r=>r.label==='Head of Data').aliases.includes('Chief Data Officer'));
});

test('role selection stays scoped to chosen group',()=>{
  const r=getRoles(['flagged-it-manager','not-ceo'],'flagged');assert.deepEqual(r.map(x=>x.id),['flagged-it-manager']);
});

test('canonicalLinkedIn strips locale, query and trailing slash',()=>{
  assert.equal(canonicalLinkedIn('https://uk.linkedin.com/in/jane-doe/?trk=abc'),'https://www.linkedin.com/in/jane-doe');
  assert.equal(canonicalLinkedIn('https://www.linkedin.com/company/acme'),null);
});

test('role matcher strongly recognizes supplied aliases',()=>{
  const role=FLAGGED.find(r=>r.id==='flagged-infrastructure-manager');const m=aliasScore('Jane Doe — Global IT Infrastructure Manager at Acme',role);assert.ok(m.score>=98);assert.match(m.alias,/Infrastructure Manager/i);
});

test('query planner creates LinkedIn dorks containing company and aliases',()=>{
  const role=FLAGGED.find(r=>r.id==='flagged-it-manager');const q=makeQueries('Acme Corp',role);assert.ok(q.length>=2);assert.match(q[0].query,/site:linkedin\.com\/in/);assert.match(q[0].query,/Acme Corp/);assert.match(q[0].query,/IT Manager/);
});

test('prospecting service deduplicates the same LinkedIn profile across engines',async()=>{
  const fake=async(engine,query)=>[
    {engine,query,url:'https://www.linkedin.com/in/jane-doe/?trk=x',title:'Jane Doe - IT Manager - Acme Corp | LinkedIn',snippet:'Jane Doe is currently IT Manager at Acme Corp.'},
    {engine,query,url:'https://uk.linkedin.com/in/jane-doe',title:'Jane Doe - Information Technology Manager at Acme Corp | LinkedIn',snippet:'Information Technology Manager at Acme Corp'}
  ];
  const svc=new ProspectingService({engineRunner:fake,engines:()=>['one','two']});
  const started=svc.start({company:'Acme Corp',group:'flagged',roleIds:['flagged-it-manager']});
  for(let i=0;i<80;i++){const j=svc.status(started.jobId);if(j.status!=='running'){assert.equal(j.status,'done');assert.equal(j.results.length,1);assert.equal(j.results[0].linkedinUrl,'https://www.linkedin.com/in/jane-doe');assert.ok(j.results[0].roleConfidence>=98);assert.ok(j.results[0].sourceCount>=2);return}await new Promise(r=>setTimeout(r,10))}
  assert.fail('prospecting job did not finish');
});

const {LinkedInDirectCollector,makeVariables,parsePeople,parseCompanies,parseTotal,csrfValue}=require('../src/prospecting/linkedinDirect');

test('LinkedIn Direct variables use current company + people + network partitions',()=>{
  const v=makeVariables({keywords:'"IT Manager"',companyId:'1035',start:25,count:25,resultType:'PEOPLE',networkDepth:'F'});
  assert.match(v,/start:25/);assert.match(v,/key:currentCompany,value:List\(1035\)/);assert.match(v,/key:resultType,value:List\(PEOPLE\)/);assert.match(v,/key:network,value:List\(F\)/);assert.match(v,/keywords:"IT Manager"/);
  assert.equal(csrfValue('"ajax:123456"'),'ajax:123456');
});

test('LinkedIn Direct parsers normalize company and people search payloads',()=>{
  const companyPayload={data:{searchDashClustersByAll:{metadata:{totalResultCount:2},elements:[{items:[{item:{entityUrn:'urn:li:fsd_company:1035',title:{text:'Microsoft'},navigationUrl:'https://www.linkedin.com/company/microsoft/'}}]}]}}};
  const companies=parseCompanies(companyPayload,'Microsoft');assert.equal(companies[0].id,'1035');assert.equal(companies[0].score,100);assert.equal(parseTotal(companyPayload),2);
  const peoplePayload={data:{searchDashClustersByAll:{metadata:{totalResultCount:1},elements:[{items:[{item:{navigationUrl:'https://www.linkedin.com/in/jane-doe/',title:{text:'Jane Doe'},primarySubtitle:{text:'Global IT Manager'},secondarySubtitle:{text:'London, UK'}}}]}]}}};
  const people=parsePeople(peoplePayload,{company:'Microsoft',query:'IT Manager'});assert.equal(people.length,1);assert.equal(people[0].url,'https://www.linkedin.com/in/jane-doe');assert.equal(people[0].name,'Jane Doe');assert.equal(people[0].headline,'Global IT Manager');assert.equal(people[0].location,'London, UK');
});

test('LinkedIn Direct adaptively partitions oversized company-role buckets by network depth',async()=>{
  const calls=[];const fakeClient={configured:()=>true,transportName:()=> 'test',resolveCompany:async()=>({id:'1035',name:'Microsoft',score:100}),search:async args=>{calls.push(args);if(!args.networkDepth)return{total:500,people:[{engine:'linkedin-direct',url:'https://www.linkedin.com/in/root-person',title:'Root Person - IT Manager - Microsoft | LinkedIn',snippet:'IT Manager · Microsoft',name:'Root Person',headline:'IT Manager',direct:true}]};return{total:1,people:[{engine:'linkedin-direct',url:`https://www.linkedin.com/in/${args.networkDepth.toLowerCase()}-person`,title:`${args.networkDepth} Person - IT Manager - Microsoft | LinkedIn`,snippet:'IT Manager · Microsoft',name:`${args.networkDepth} Person`,headline:'IT Manager',direct:true}]};},close:async()=>{}};
  const env={LINKEDIN_DIRECT_MAX_REQUESTS:'20',LINKEDIN_DIRECT_PAGE_SIZE:'25',LINKEDIN_DIRECT_PARTITION_AT:'100',LINKEDIN_DIRECT_BUCKET_CAP:'900',LINKEDIN_DIRECT_ALIASES_PER_ROLE:'1',LINKEDIN_DIRECT_DELAY_MS:'0'};
  const collector=new LinkedInDirectCollector({client:fakeClient,env});const role=FLAGGED.find(r=>r.id==='flagged-it-manager');const out=await collector.discover({company:'Microsoft',roles:[role]});assert.equal(out.stats.partitions,1);assert.equal(out.stats.requests,4);assert.deepEqual(calls.map(x=>x.networkDepth||'BASE'),['BASE','F','S','O']);assert.ok(out.rows.length>=4);
});

test('prospecting capabilities expose LinkedIn Direct without leaking cookies',()=>{
  const fakeDirect={configured:()=>true,capabilities:()=>({configured:true,transport:'test-browser',requires:['LINKEDIN_LI_AT','LINKEDIN_JSESSIONID'],strategy:'test'}),discover:async()=>({configured:true,rows:[],stats:{}})};
  const svc=new ProspectingService({directCollector:fakeDirect,engineRunner:async()=>[],engines:()=>[]});const c=svc.capabilities();assert.equal(c.linkedinDirect.configured,true);assert.equal(c.linkedinDirect.transport,'test-browser');assert.equal(JSON.stringify(c).includes('li_at='),false);
});

test('public OSINT planner recursively splits saturated alias bundles',async()=>{
  let calls=0;const fake=async(engine,query,limit)=>{calls++;if(/ OR /.test(query))return Array.from({length:limit},(_,i)=>({engine,query,url:`https://www.linkedin.com/in/saturated-${calls}-${i}`,title:`Person ${i} - IT Manager - Acme Corp | LinkedIn`,snippet:'IT Manager at Acme Corp'}));return[]};
  const direct={configured:()=>false,capabilities:()=>({configured:false,transport:null}),discover:async()=>({configured:false,rows:[],stats:{}})};
  const oldLimit=process.env.PROSPECT_RESULTS_PER_QUERY,oldDepth=process.env.PROSPECT_ADAPTIVE_SPLIT_DEPTH,oldChunks=process.env.PROSPECT_MAX_ALIAS_CHUNKS_PER_ROLE,oldMax=process.env.PROSPECT_MAX_QUERIES;process.env.PROSPECT_RESULTS_PER_QUERY='5';process.env.PROSPECT_ADAPTIVE_SPLIT_DEPTH='2';process.env.PROSPECT_MAX_ALIAS_CHUNKS_PER_ROLE='1';process.env.PROSPECT_MAX_QUERIES='1';
  try{const svc=new ProspectingService({engineRunner:fake,engines:()=>['fake'],directCollector:direct});const started=svc.start({company:'Acme Corp',group:'flagged',roleIds:['flagged-it-manager']});for(let i=0;i<120;i++){const j=svc.status(started.jobId);if(j.status!=='running'){assert.equal(j.status,'done');assert.ok(j.progress.adaptivePartitions>=1);assert.ok(calls>1);return}await new Promise(r=>setTimeout(r,10))}assert.fail('adaptive prospecting job did not finish')}finally{if(oldLimit==null)delete process.env.PROSPECT_RESULTS_PER_QUERY;else process.env.PROSPECT_RESULTS_PER_QUERY=oldLimit;if(oldDepth==null)delete process.env.PROSPECT_ADAPTIVE_SPLIT_DEPTH;else process.env.PROSPECT_ADAPTIVE_SPLIT_DEPTH=oldDepth;if(oldChunks==null)delete process.env.PROSPECT_MAX_ALIAS_CHUNKS_PER_ROLE;else process.env.PROSPECT_MAX_ALIAS_CHUNKS_PER_ROLE=oldChunks;if(oldMax==null)delete process.env.PROSPECT_MAX_QUERIES;else process.env.PROSPECT_MAX_QUERIES=oldMax}
});

test('LinkedIn Direct allocates early alias coverage round-robin across selected roles',async()=>{
  const seen=[];const fakeClient={requestCount:0,configured:()=>true,transportName:()=> 'test',resolveCompany:async()=>({id:'7',name:'Acme',score:100}),search:async args=>{fakeClient.requestCount++;seen.push(args.keywords);return{total:0,people:[]}},close:async()=>{}};
  const env={LINKEDIN_DIRECT_MAX_REQUESTS:'6',LINKEDIN_DIRECT_PAGE_SIZE:'25',LINKEDIN_DIRECT_PARTITION_AT:'100',LINKEDIN_DIRECT_BUCKET_CAP:'900',LINKEDIN_DIRECT_ALIASES_PER_ROLE:'3',LINKEDIN_DIRECT_DELAY_MS:'0'};
  const collector=new LinkedInDirectCollector({client:fakeClient,env});const r1=FLAGGED.find(r=>r.id==='flagged-it-manager'),r2=FLAGGED.find(r=>r.id==='flagged-it-director');await collector.discover({company:'Acme',roles:[r1,r2]});assert.match(seen[0],/IT Manager/i);assert.match(seen[1],/IT Director/i);
});

const {LinkedInCircuitBreaker,persistentProfileDir}=require('../src/prospecting/linkedinDirect');

test('LinkedIn circuit breaker opens on provider protection signals and recovers through half-open',()=>{
  const breaker=new LinkedInCircuitBreaker({LINKEDIN_CIRCUIT_RATE_LIMIT_COOLDOWN_MS:'60000'});
  breaker.failure(Object.assign(new Error('rate limited'),{code:'RATE_LIMIT',meta:{retryAfterMs:1000}}));
  assert.equal(breaker.snapshot().state,'OPEN');
  assert.throws(()=>breaker.assertCanRequest(),e=>e.code==='CIRCUIT_OPEN');
  breaker.nextAttemptAt=Date.now()-1;
  breaker.assertCanRequest();
  assert.equal(breaker.snapshot().state,'HALF_OPEN');
  breaker.success();
  assert.equal(breaker.snapshot().state,'CLOSED');
});

test('LinkedIn Direct request budget is per prospecting job, not lifetime client count',async()=>{
  const seen=[];
  const fakeClient={requestCount:0,configured:()=>true,transportName:()=> 'test-persistent',sessionState:()=>({circuit:{state:'CLOSED'},rate:{requestsLastMinute:0,maxPerMinute:20}}),resolveCompany:async()=>{fakeClient.requestCount++;return{id:'7',name:'Acme',score:100}},search:async args=>{fakeClient.requestCount++;seen.push(args.keywords);return{total:0,people:[]}},close:async()=>{}};
  const env={LINKEDIN_DIRECT_MAX_REQUESTS:'3',LINKEDIN_DIRECT_PAGE_SIZE:'25',LINKEDIN_DIRECT_PARTITION_AT:'100',LINKEDIN_DIRECT_BUCKET_CAP:'900',LINKEDIN_DIRECT_ALIASES_PER_ROLE:'1',LINKEDIN_DIRECT_DELAY_MS:'0'};
  const collector=new LinkedInDirectCollector({client:fakeClient,env});const role=FLAGGED.find(r=>r.id==='flagged-it-manager');
  const first=await collector.discover({company:'Acme',roles:[role]});
  const second=await collector.discover({company:'Acme',roles:[role]});
  assert.equal(first.stats.requests,2);assert.equal(second.stats.requests,2);assert.equal(seen.length,2);
});

test('persistent LinkedIn profile directory is stable across calls',()=>{
  const old=process.env.LINKEDIN_PROFILE_DIR;process.env.LINKEDIN_PROFILE_DIR='/tmp/beast-test-persistent-profile';
  try{assert.equal(persistentProfileDir(),'/tmp/beast-test-persistent-profile');assert.equal(persistentProfileDir(),'/tmp/beast-test-persistent-profile')}finally{if(old==null)delete process.env.LINKEDIN_PROFILE_DIR;else process.env.LINKEDIN_PROFILE_DIR=old}
});

test('prospecting jobs can be stopped and preserve discovered results',async()=>{
  let calls=0;
  const fake=async(engine,query)=>{calls++;await new Promise(r=>setTimeout(r,15));return [{engine,query,url:`https://www.linkedin.com/in/person-${calls}`,title:`Person ${calls} - IT Manager - Acme Corp | LinkedIn`,snippet:'IT Manager at Acme Corp'}]};
  const direct={configured:()=>false,capabilities:()=>({configured:false,transport:null}),discover:async()=>({configured:false,rows:[],stats:{}})};
  const old=process.env.PROSPECT_MAX_ALIAS_CHUNKS_PER_ROLE;process.env.PROSPECT_MAX_ALIAS_CHUNKS_PER_ROLE='4';
  try{
    const svc=new ProspectingService({engineRunner:fake,engines:()=>['one','two'],directCollector:direct});
    const started=svc.start({company:'Acme Corp',group:'flagged',roleIds:['flagged-it-manager']});
    await new Promise(r=>setTimeout(r,20));
    const stopping=svc.stop(started.jobId);assert.equal(stopping.progress.stopRequested,true);
    for(let i=0;i<100;i++){const j=svc.status(started.jobId);if(j.status!=='running'){assert.equal(j.status,'stopped');assert.match(j.progress.stage,/Stopped/i);assert.ok(Array.isArray(j.results));return}await new Promise(r=>setTimeout(r,10))}
    assert.fail('stopped prospecting job did not terminate');
  }finally{if(old==null)delete process.env.PROSPECT_MAX_ALIAS_CHUNKS_PER_ROLE;else process.env.PROSPECT_MAX_ALIAS_CHUNKS_PER_ROLE=old}
});

test('LinkedIn Direct reports the real early-failure stage and request count',async()=>{
  const events=[];
  const err=Object.assign(new Error('session expired'),{code:'AUTH_REQUIRED'});
  const fakeClient={requestCount:0,configured:()=>true,transportName:()=> 'test',sessionState:()=>({circuit:{state:'CLOSED'},rate:{requestsLastMinute:0,maxPerMinute:20}}),verify:async()=>{fakeClient.requestCount++;throw err},resolveCompany:async()=>{throw new Error('should not run')},close:async()=>{}};
  const collector=new LinkedInDirectCollector({client:fakeClient,env:{LINKEDIN_DIRECT_MAX_REQUESTS:'10'}});
  const role=FLAGGED.find(r=>r.id==='flagged-cybersecurity-manager');
  await assert.rejects(()=>collector.discover({company:'Acme',roles:[role],onEvent:e=>events.push(e)}),e=>e.code==='AUTH_REQUIRED');
  const failure=events.find(e=>e.type==='failure');assert.ok(failure);assert.equal(failure.stage,'session verification');assert.equal(failure.requests,1);
});
