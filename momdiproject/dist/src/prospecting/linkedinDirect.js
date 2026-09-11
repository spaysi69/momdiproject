'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const crypto=require('node:crypto');

const DEFAULT_QUERY_IDS=[
  'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0',
  'voyagerSearchDashClusters.994bf4e7d2173b92ccdb5935710c3c5d'
];
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function envBool(v,def=false){if(v==null||v==='')return def;return /^(1|true|yes|on)$/i.test(String(v))}
function norm(v=''){return String(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function jsidBase(raw=''){return String(raw).replace(/^['"]|['"]$/g,'').replace(/^ajax:/,'')}
function csrfValue(raw=''){const b=jsidBase(raw);return b?`ajax:${b}`:''}
function findChromium(){const candidates=[process.env.CHROMIUM_PATH,'/usr/bin/chromium-browser','/usr/bin/chromium','/usr/bin/google-chrome','/usr/bin/google-chrome-stable'].filter(Boolean);return candidates.find(p=>{try{return fs.existsSync(p)}catch{return false}})||null}
function persistentProfileDir(){const dir=String(process.env.LINKEDIN_PROFILE_DIR||'/tmp/prospecting-beast-linkedin-profile').trim()||'/tmp/prospecting-beast-linkedin-profile';try{fs.mkdirSync(dir,{recursive:true})}catch{}return dir}
function walk(value,fn,path=[]){if(!value||typeof value!=='object')return;fn(value,path);if(Array.isArray(value)){for(let i=0;i<value.length;i++)walk(value[i],fn,path.concat(i))}else for(const [k,v] of Object.entries(value))walk(v,fn,path.concat(k))}
function textValue(v){if(v==null)return'';if(typeof v==='string')return v;if(typeof v==='number')return String(v);if(typeof v==='object'){if(typeof v.text==='string')return v.text;if(typeof v.textDirection==='string'&&typeof v.text==='string')return v.text;if(Array.isArray(v.attributes)&&typeof v.text==='string')return v.text}return''}
function pickText(obj,keys){for(const k of keys){const t=textValue(obj?.[k]);if(t)return t.trim()}return''}
function companyIdFromObject(o){const vals=[o?.entityUrn,o?.trackingUrn,o?.targetUrn,o?.urn,o?.companyUrn];for(const v of vals){const m=String(v||'').match(/urn:li:(?:fsd_)?company:(\d+)/i);if(m)return m[1]}return null}
function profileUrlFromObject(o){const vals=[o?.navigationUrl,o?.url,o?.profileUrl,o?.publicProfileUrl];for(const v of vals){const m=String(v||'').match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+/i);if(m)return m[0].replace(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com/i,'https://www.linkedin.com').replace(/\/$/,'')}const pid=o?.publicIdentifier||o?.publicId;return pid?`https://www.linkedin.com/in/${String(pid).replace(/^\/+|\/+$/g,'')}`:null}
function companyUrlFromObject(o){const vals=[o?.navigationUrl,o?.url,o?.companyUrl];for(const v of vals){const m=String(v||'').match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[^/?#]+/i);if(m)return m[0].replace(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com/i,'https://www.linkedin.com').replace(/\/$/,'')}return null}
function parseTotal(payload){let best=0;walk(payload,o=>{for(const k of ['totalResultCount','total','totalCount']){const n=Number(o?.[k]);if(Number.isFinite(n)&&n>best&&n<100000000)best=n}});return best}
function parsePeople(payload,{company='',query=''}={}){const map=new Map();walk(payload,o=>{const url=profileUrlFromObject(o);if(!url)return;const name=pickText(o,['title','name','fullName','firstName']);let headline=pickText(o,['primarySubtitle','headline','subtitle','occupation','title']);let location=pickText(o,['secondarySubtitle','location']);if(headline&&name&&norm(headline)===norm(name))headline='';if(!headline){for(const k of ['summary','description']){const t=textValue(o?.[k]);if(t&&t.length<240){headline=t;break}}}
    const existing=map.get(url);const row={engine:'linkedin-direct',query,url,title:name?`${name}${headline?` - ${headline}`:''}${company?` - ${company}`:''} | LinkedIn`:`${headline||query} | LinkedIn`,snippet:[headline,location,company].filter(Boolean).join(' · '),name:name||'',headline:headline||'',location:location||'',direct:true};if(!existing||row.title.length+row.snippet.length>existing.title.length+existing.snippet.length)map.set(url,row)});return [...map.values()]}
function parseCompanies(payload,company){const candidates=[];walk(payload,o=>{const id=companyIdFromObject(o);const url=companyUrlFromObject(o);if(!id&&!url)return;const name=pickText(o,['title','name','companyName','primarySubtitle']);const slug=url?url.split('/company/')[1]?.split('/')[0]||'':'';const target=norm(company),n=norm(name),s=norm(slug.replace(/-/g,' '));let score=0;if(n===target)score=100;else if(s===target)score=98;else if(n.includes(target)||target.includes(n))score=88;else{const at=new Set(target.split(' ')),bt=new Set(n.split(' '));const hit=[...at].filter(x=>bt.has(x)).length;score=at.size?Math.round(80*hit/at.size):0}candidates.push({id,name:name||slug,url,slug,score})});const uniq=new Map();for(const c of candidates){const key=c.id||c.url;if(!key)continue;const e=uniq.get(key);if(!e||c.score>e.score)uniq.set(key,c)}return [...uniq.values()].sort((a,b)=>b.score-a.score)}
function makeVariables({keywords='',companyId=null,start=0,count=25,resultType='PEOPLE',networkDepth=null}){const qp=[];if(companyId)qp.push(`(key:currentCompany,value:List(${companyId}))`);qp.push(`(key:resultType,value:List(${resultType}))`);if(networkDepth)qp.push(`(key:network,value:List(${networkDepth}))`);const kw=String(keywords||'').replace(/[(),]/g,' ').replace(/\s+/g,' ').trim();return `(start:${Math.max(0,start)},count:${Math.max(1,Math.min(50,count))},origin:FACETED_SEARCH,query:(${kw?`keywords:${kw},`:''}flagshipSearchIntent:SEARCH_SRP,queryParameters:List(${qp.join(',')}),includeFiltersInResponse:false))`}
class LinkedInDirectError extends Error{constructor(message,code='LINKEDIN_DIRECT_ERROR',meta={}){super(message);this.name='LinkedInDirectError';this.code=code;this.meta=meta}}

class LinkedInCircuitBreaker{
  constructor(env=process.env){this.env=env;this.state='CLOSED';this.openedAt=null;this.nextAttemptAt=null;this.reason=null;this.consecutiveTransient=0;this.halfOpenProbe=false;this.transientThreshold=Math.max(1,Number(env.LINKEDIN_CIRCUIT_TRANSIENT_THRESHOLD||3));this.rateLimitCooldownMs=Math.max(60000,Number(env.LINKEDIN_CIRCUIT_RATE_LIMIT_COOLDOWN_MS||900000));this.authCooldownMs=Math.max(60000,Number(env.LINKEDIN_CIRCUIT_AUTH_COOLDOWN_MS||1800000));this.transientCooldownMs=Math.max(30000,Number(env.LINKEDIN_CIRCUIT_TRANSIENT_COOLDOWN_MS||120000))}
  #open(reason,cooldownMs){this.state='OPEN';this.openedAt=Date.now();this.nextAttemptAt=this.openedAt+cooldownMs;this.reason=reason;this.halfOpenProbe=false}
  assertCanRequest(){if(this.state!=='OPEN')return;if(Date.now()>=(this.nextAttemptAt||0)){this.state='HALF_OPEN';this.halfOpenProbe=true;return}throw new LinkedInDirectError(`LinkedIn Direct circuit is open after ${this.reason||'provider protection signal'}.`, 'CIRCUIT_OPEN',{reason:this.reason,nextAttemptAt:this.nextAttemptAt})}
  success(){this.state='CLOSED';this.openedAt=null;this.nextAttemptAt=null;this.reason=null;this.consecutiveTransient=0;this.halfOpenProbe=false}
  failure(error){const code=String(error?.code||'');if(code==='RATE_LIMIT'){const retry=Number(error?.meta?.retryAfterMs||0);this.#open(code,Math.max(this.rateLimitCooldownMs,retry));return}if(['CHECKPOINT','AUTH_REQUIRED'].includes(code)){this.#open(code,this.authCooldownMs);return}if(code==='CIRCUIT_OPEN')return;const status=Number(error?.meta?.status||0);if(code==='HTTP_ERROR'&&status>=500){this.consecutiveTransient++;if(this.consecutiveTransient>=this.transientThreshold)this.#open(`HTTP_${status}`,this.transientCooldownMs)}else if(!['CHROMIUM_UNAVAILABLE','CHROMIUM_START_FAILED'].includes(code)){this.consecutiveTransient=0}}
  snapshot(){return{state:this.state,reason:this.reason,openedAt:this.openedAt?new Date(this.openedAt).toISOString():null,nextAttemptAt:this.nextAttemptAt?new Date(this.nextAttemptAt).toISOString():null,consecutiveTransient:this.consecutiveTransient}}
}
class LinkedInRateController{
  constructor(env=process.env){this.minDelayMs=Math.max(250,Number(env.LINKEDIN_RATE_MIN_DELAY_MS||1200));this.maxPerMinute=Math.max(1,Number(env.LINKEDIN_RATE_MAX_PER_MINUTE||20));this.maxPerHour=Math.max(this.maxPerMinute,Number(env.LINKEDIN_RATE_MAX_PER_HOUR||240));this.lastRequestAt=0;this.timestamps=[];this.penaltyMs=0}
  #prune(now){this.timestamps=this.timestamps.filter(t=>now-t<3600000)}
  async beforeRequest(){let now=Date.now();this.#prune(now);const minute=this.timestamps.filter(t=>now-t<60000);let wait=Math.max(0,this.lastRequestAt+this.minDelayMs+this.penaltyMs-now);if(minute.length>=this.maxPerMinute)wait=Math.max(wait,minute[0]+60000-now);if(this.timestamps.length>=this.maxPerHour)wait=Math.max(wait,this.timestamps[0]+3600000-now);if(wait>0)await sleep(wait);now=Date.now();this.#prune(now);this.lastRequestAt=now;this.timestamps.push(now)}
  success(){this.penaltyMs=Math.max(0,Math.floor(this.penaltyMs*.5)-100)}
  failure(error){if(error?.code==='RATE_LIMIT')this.penaltyMs=Math.min(30000,Math.max(this.penaltyMs*2,this.minDelayMs*4));else if(error?.code==='HTTP_ERROR'&&Number(error?.meta?.status||0)>=500)this.penaltyMs=Math.min(10000,Math.max(this.penaltyMs*2,this.minDelayMs))}
  snapshot(){const now=Date.now();this.#prune(now);return{minDelayMs:this.minDelayMs,maxPerMinute:this.maxPerMinute,maxPerHour:this.maxPerHour,requestsLastMinute:this.timestamps.filter(t=>now-t<60000).length,requestsLastHour:this.timestamps.length,penaltyMs:this.penaltyMs,lastRequestAt:this.lastRequestAt?new Date(this.lastRequestAt).toISOString():null}}
}
class CdpConnection{
  constructor(wsUrl){this.wsUrl=wsUrl;this.ws=null;this.seq=0;this.pending=new Map();this.events=[]}
  async connect(){this.ws=new WebSocket(this.wsUrl);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CDP websocket timeout')),10000);this.ws.onopen=()=>{clearTimeout(timer);resolve()};this.ws.onerror=e=>{clearTimeout(timer);reject(new Error('CDP websocket failed'))}});this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.id&&this.pending.has(m.id)){const p=this.pending.get(m.id);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message||'CDP command failed')):p.resolve(m.result);return}this.events.push(m);if(this.events.length>1000)this.events.shift()};return this}
  command(method,params={},sessionId){const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`))},20000);this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})}
  close(){try{this.ws?.close()}catch{}}
}
class LinkedInBrowserTransport{
  constructor(config){this.config=config;this.proc=null;this.cdp=null;this.sessionId=null;this.port=Number(process.env.LINKEDIN_CHROMIUM_DEBUG_PORT||9223);this.executable=findChromium();this.profileDir=persistentProfileDir();this.startedAt=null;this.reuseCount=0}
  available(){return Boolean(this.executable&&globalThis.WebSocket)}
  running(){return Boolean(this.cdp&&this.proc&&!this.proc.killed)}
  async start(){if(this.running()){this.reuseCount++;return}if(this.cdp){this.cdp.close();this.cdp=null;this.sessionId=null}if(!this.available())throw new LinkedInDirectError('Chromium transport is unavailable.','CHROMIUM_UNAVAILABLE');const args=['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-background-networking','--disable-default-apps','--disable-extensions','--disable-sync','--metrics-recording-only',`--remote-debugging-port=${this.port}`,`--user-data-dir=${this.profileDir}`,'about:blank'];this.proc=spawn(this.executable,args,{stdio:'ignore'});this.proc.once('exit',()=>{this.proc=null;this.cdp?.close();this.cdp=null;this.sessionId=null});let info=null;for(let i=0;i<40;i++){try{const r=await fetch(`http://127.0.0.1:${this.port}/json/version`,{signal:AbortSignal.timeout(1000)});if(r.ok){info=await r.json();break}}catch{}await sleep(250)}if(!info?.webSocketDebuggerUrl)throw new LinkedInDirectError('Chromium DevTools endpoint did not start.','CHROMIUM_START_FAILED');this.cdp=await new CdpConnection(info.webSocketDebuggerUrl).connect();const target=await this.cdp.command('Target.createTarget',{url:'about:blank'});const attached=await this.cdp.command('Target.attachToTarget',{targetId:target.targetId,flatten:true});this.sessionId=attached.sessionId;await this.cdp.command('Page.enable',{},this.sessionId);await this.cdp.command('Runtime.enable',{},this.sessionId);await this.cdp.command('Network.enable',{},this.sessionId);const csrf=csrfValue(this.config.jsessionid);await this.cdp.command('Network.setCookies',{cookies:[{name:'li_at',value:this.config.liAt,domain:'.linkedin.com',path:'/',secure:true,httpOnly:true,sameSite:'None'},{name:'JSESSIONID',value:`ajax:${jsidBase(this.config.jsessionid)}`,domain:'.linkedin.com',path:'/',secure:true,httpOnly:false,sameSite:'None'}]},this.sessionId);await this.cdp.command('Page.navigate',{url:'https://www.linkedin.com/feed/'},this.sessionId);await sleep(1800);const check=await this.evaluate(`location.href`);if(/login|checkpoint|challenge/i.test(String(check)))throw new LinkedInDirectError('LinkedIn session reached a login/checkpoint page. Refresh LINKEDIN_LI_AT and LINKEDIN_JSESSIONID.','AUTH_REQUIRED',{url:check});this.csrf=csrf;this.startedAt=new Date().toISOString()}
  async evaluate(expression){const r=await this.cdp.command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:false},this.sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.text||'Browser evaluation failed');return r.result?.value}
  async request(path){await this.start();const csrf=this.csrf;const expr=`(async()=>{const r=await fetch(${JSON.stringify(path)},{credentials:'include',headers:{'accept':'application/vnd.linkedin.normalized+json+2.1','csrf-token':${JSON.stringify(csrf)},'x-restli-protocol-version':'2.0.0','x-li-lang':'en_US'}});return {status:r.status,url:r.url,retryAfter:r.headers.get('retry-after'),text:await r.text()}})()`;try{const out=await this.evaluate(expr);return normalizeLinkedInResponse(out)}catch(error){if(!this.proc||this.proc.killed){this.cdp?.close();this.cdp=null;this.sessionId=null}throw error}}
  async close(){/* Persistent session: keep Chromium alive across prospecting jobs. */}
  async shutdown(){this.cdp?.close();this.cdp=null;this.sessionId=null;if(this.proc){try{this.proc.kill('SIGTERM')}catch{}this.proc=null}}
  snapshot(){return{persistent:true,profileDir:this.profileDir,running:this.running(),startedAt:this.startedAt,reuseCount:this.reuseCount}}
}

function normalizeLinkedInResponse(out){const status=Number(out?.status||0),url=String(out?.url||'');const text=String(out?.text||'');const retryRaw=String(out?.retryAfter||'').trim();const retrySecs=Number(retryRaw);const retryAfterMs=Number.isFinite(retrySecs)&&retrySecs>0?retrySecs*1000:0;if(status===429)throw new LinkedInDirectError('LinkedIn rate limit reached. Direct collection stopped.','RATE_LIMIT',{status,retryAfterMs});if(status===999)throw new LinkedInDirectError('LinkedIn rejected the automated request (999).','CHECKPOINT',{status});if(/\/checkpoint\/|\/challenge\/|\/login/i.test(url)||/checkpoint|security verification|challenge/i.test(text.slice(0,1000)))throw new LinkedInDirectError('LinkedIn requested login/checkpoint verification.','AUTH_REQUIRED',{status,url});if(status<200||status>=300)throw new LinkedInDirectError(`LinkedIn returned HTTP ${status}.`,'HTTP_ERROR',{status,url,body:text.slice(0,500)});let data;try{data=JSON.parse(text)}catch{throw new LinkedInDirectError('LinkedIn returned non-JSON search data.','BAD_RESPONSE',{status,url})}return{status,url,data}}
class LinkedInFetchTransport{
  constructor(config){this.config=config}
  available(){return Boolean(this.config.liAt&&this.config.jsessionid)}
  async request(path){const csrf=csrfValue(this.config.jsessionid);const cookie=`li_at=${this.config.liAt}; JSESSIONID="${csrf}"`;const r=await fetch(new URL(path,'https://www.linkedin.com'),{redirect:'manual',headers:{'accept':'application/vnd.linkedin.normalized+json+2.1','cookie':cookie,'csrf-token':csrf,'x-restli-protocol-version':'2.0.0','x-li-lang':'en_US','user-agent':UA,'referer':'https://www.linkedin.com/search/results/people/'},signal:AbortSignal.timeout(this.config.timeoutMs)});const text=await r.text();return normalizeLinkedInResponse({status:r.status,url:r.headers.get('location')||r.url,retryAfter:r.headers.get('retry-after'),text})}
  async close(){}
}
class LinkedInDirectClient{
  constructor(env=process.env){this.env=env;this.config={enabled:envBool(env.LINKEDIN_DIRECT_ENABLED,true),liAt:String(env.LINKEDIN_LI_AT||''),jsessionid:String(env.LINKEDIN_JSESSIONID||''),timeoutMs:Math.max(5000,Number(env.LINKEDIN_DIRECT_TIMEOUT_MS||25000)),queryIds:String(env.LINKEDIN_SEARCH_QUERY_ID||'').split(',').map(s=>s.trim()).filter(Boolean)};if(!this.config.queryIds.length)this.config.queryIds=DEFAULT_QUERY_IDS.slice();const wanted=String(env.LINKEDIN_DIRECT_TRANSPORT||'auto').toLowerCase();this.browser=new LinkedInBrowserTransport(this.config);this.fetchTransport=new LinkedInFetchTransport(this.config);this.transport=wanted==='fetch'?this.fetchTransport:wanted==='browser'?this.browser:(this.browser.available()?this.browser:this.fetchTransport);this.queryIdIndex=0;this.requestCount=0;this.rate=new LinkedInRateController(env);this.circuit=new LinkedInCircuitBreaker(env)}
  configured(){return this.config.enabled&&Boolean(this.config.liAt&&this.config.jsessionid)}
  transportName(){return this.transport===this.browser?'chromium-inpage':'authenticated-fetch'}
  sessionState(){return{transport:this.transportName(),persistentProfile:this.transport===this.browser?this.browser.snapshot():{persistent:false},circuit:this.circuit.snapshot(),rate:this.rate.snapshot(),requestCount:this.requestCount}}
  async request(path){if(!this.configured())throw new LinkedInDirectError('LinkedIn Direct is not configured.','NOT_CONFIGURED');this.circuit.assertCanRequest();await this.rate.beforeRequest();this.requestCount++;try{const out=await this.transport.request(path);this.rate.success();this.circuit.success();return out}catch(e){if(this.transport===this.browser&&String(this.env.LINKEDIN_DIRECT_TRANSPORT||'auto').toLowerCase()==='auto'&&['CHROMIUM_UNAVAILABLE','CHROMIUM_START_FAILED'].includes(e.code)){this.transport=this.fetchTransport;try{const out=await this.transport.request(path);this.rate.success();this.circuit.success();return out}catch(inner){this.rate.failure(inner);this.circuit.failure(inner);throw inner}}this.rate.failure(e);this.circuit.failure(e);throw e}}
  async verify(){const r=await this.request('/voyager/api/me');return{ok:true,transport:this.transportName(),status:r.status,session:this.sessionState()}}
  async search({keywords='',companyId=null,start=0,count=25,resultType='PEOPLE',networkDepth=null}){let last;for(let i=0;i<this.config.queryIds.length;i++){const idx=(this.queryIdIndex+i)%this.config.queryIds.length;const queryId=this.config.queryIds[idx];const variables=makeVariables({keywords,companyId,start,count,resultType,networkDepth});const path=`/voyager/api/graphql?variables=${encodeURIComponent(variables)}&queryId=${encodeURIComponent(queryId)}`;try{const r=await this.request(path);this.queryIdIndex=idx;return{...r,queryId,total:parseTotal(r.data),people:resultType==='PEOPLE'?parsePeople(r.data,{query:keywords}):[],companies:resultType==='COMPANIES'?parseCompanies(r.data,keywords):[]}}catch(e){last=e;if(e.code!=='HTTP_ERROR'||![400,404].includes(Number(e.meta?.status)))throw e}}throw last||new LinkedInDirectError('No LinkedIn search query ID succeeded.','QUERY_ID_FAILED')}
  async resolveCompany(company){const r=await this.search({keywords:company,resultType:'COMPANIES',count:10});const best=r.companies[0];if(!best||best.score<55)throw new LinkedInDirectError(`Could not resolve a LinkedIn company for "${company}".`,'COMPANY_NOT_FOUND',{candidates:r.companies.slice(0,5)});return{...best,totalCandidates:r.companies.length,queryId:r.queryId}}
  async close(){await this.browser.close()}
  async shutdown(){await this.browser.shutdown()}
}

class LinkedInDirectCollector{
  constructor({client=new LinkedInDirectClient(),env=process.env}={}){this.client=client;this.env=env;this.queue=Promise.resolve()}
  configured(){return this.client.configured()}
  capabilities(){return{configured:this.configured(),transport:this.configured()?this.client.transportName():null,requires:['LINKEDIN_LI_AT','LINKEDIN_JSESSIONID'],strategy:'persistent authenticated session + current-company Voyager search + adaptive partitioning',session:this.client.sessionState?this.client.sessionState():null}}
  discover(args){const run=this.queue.then(()=>this._discover(args));this.queue=run.catch(()=>{});return run}
  async _discover({company,roles,onEvent=()=>{},onRow=()=>{},shouldStop=()=>false}){
    if(!this.configured())return{configured:false,rows:[],stats:{requests:0,buckets:0,partitions:0,partialBuckets:0}};
    const maxRequests=Math.max(10,Number(this.env.LINKEDIN_DIRECT_MAX_REQUESTS||120));
    const pageSize=Math.max(10,Math.min(50,Number(this.env.LINKEDIN_DIRECT_PAGE_SIZE||25)));
    const bucketCap=Math.max(pageSize,Number(this.env.LINKEDIN_DIRECT_BUCKET_CAP||900));
    const partitionAt=Math.max(pageSize*2,Number(this.env.LINKEDIN_DIRECT_PARTITION_AT||400));
    const aliasesPerRole=Math.max(1,Number(this.env.LINKEDIN_DIRECT_ALIASES_PER_ROLE||16));
    const minDelay=Math.max(0,Number(this.env.LINKEDIN_DIRECT_DELAY_MS||0));
    const rows=[];
    const hasRequestCounter=Number.isFinite(Number(this.client.requestCount));
    const requestBase=hasRequestCounter?Number(this.client.requestCount):0;
    const stats={requests:0,buckets:0,partitions:0,partialBuckets:0,company:null,transport:this.client.transportName(),aliasesSearched:0,stage:'starting'};
    const updateRequests=()=>{stats.requests=hasRequestCounter?Math.max(0,Number(this.client.requestCount)-requestBase):stats.requests};
    const emitStage=stage=>{stats.stage=stage;updateRequests();onEvent({type:'direct_stage',stage,requests:stats.requests,session:this.client.sessionState?this.client.sessionState():null})};
    const stopped=()=>Boolean(shouldStop&&shouldStop());
    const stopNow=()=>{updateRequests();stats.stopped=true;stats.stage='stopped';onEvent({type:'stopped',requests:stats.requests,session:this.client.sessionState?this.client.sessionState():null});return{configured:true,rows:[],stats}};
    onEvent({type:'session_state',session:this.client.sessionState?this.client.sessionState():null});
    if(stopped())return stopNow();
    let resolved;
    try{
      if(typeof this.client.verify==='function'){
        emitStage('session verification');
        await this.client.verify();
        updateRequests();
        onEvent({type:'session_verified',requests:stats.requests,session:this.client.sessionState?this.client.sessionState():null});
      }
      if(stopped())return stopNow();
      emitStage('company resolution');
      resolved=await this.client.resolveCompany(company);
      updateRequests();stats.company=resolved;stats.session=this.client.sessionState?this.client.sessionState():null;
      onEvent({type:'company_resolved',company:resolved});
    }catch(error){
      updateRequests();
      stats.session=this.client.sessionState?this.client.sessionState():null;
      onEvent({type:'failure',stage:stats.stage,requests:stats.requests,code:error.code||null,message:error.message,session:stats.session});
      error.meta={...(error.meta||{}),stage:stats.stage,requests:stats.requests};
      throw error;
    }
    const budget=()=>{if(stats.requests>=maxRequests)throw new LinkedInDirectError('LinkedIn Direct request budget reached.','REQUEST_BUDGET',{maxRequests})};
    const doSearch=async params=>{
      if(stopped())throw new LinkedInDirectError('Prospecting stopped by user.','STOPPED');
      budget();if(stats.requests)await sleep(minDelay);
      emitStage('employee search');
      const r=await this.client.search({...params,companyId:resolved.id,count:pageSize,resultType:'PEOPLE'});
      if(!hasRequestCounter)stats.requests++;else updateRequests();stats.session=this.client.sessionState?this.client.sessionState():null;
      onEvent({type:'request',params,total:r.total,results:r.people.length,requestNo:stats.requests,session:stats.session});return r
    };
    const collectBucket=async({role,alias,networkDepth=null})=>{
      if(stopped())return;
      stats.buckets++;
      const first=await doSearch({keywords:`"${alias}"`,start:0,networkDepth});
      if(stopped())return;
      const total=first.total||first.people.length;
      const add=(page)=>{for(const p of page.people){if(stopped())break;const row={...p,company,roleId:role.id,roleLabel:role.label,matchedAlias:alias,networkDepth,totalResultCount:total};rows.push(row);onRow(row)}};add(first);
      if(!networkDepth&&total>partitionAt){stats.partitions++;onEvent({type:'partition',roleId:role.id,alias,total,by:'networkDepth'});for(const depth of ['F','S','O']){if(stopped()||stats.requests>=maxRequests)break;try{await collectBucket({role,alias,networkDepth:depth})}catch(e){if(['REQUEST_BUDGET','STOPPED'].includes(e.code))break;throw e}}return}
      const effective=Math.min(total||pageSize,bucketCap),pages=Math.ceil(effective/pageSize);
      for(let page=1;page<pages&&stats.requests<maxRequests&&!stopped();page++){const r=await doSearch({keywords:`"${alias}"`,start:page*pageSize,networkDepth});if(!r.people.length)break;add(r);if(r.people.length<pageSize)break}
      if(total>bucketCap){stats.partialBuckets++;onEvent({type:'partial_bucket',roleId:role.id,alias,networkDepth,total,cap:bucketCap})}
    };
    const aliasLists=roles.map(role=>({role,aliases:[...new Set(role.aliases)].slice(0,aliasesPerRole)})),aliasTasks=[];
    for(let depth=0;depth<aliasesPerRole;depth++)for(const entry of aliasLists)if(entry.aliases[depth])aliasTasks.push({role:entry.role,alias:entry.aliases[depth],aliasDepth:depth});
    try{
      for(const {role,alias,aliasDepth} of aliasTasks){
        if(stopped()||stats.requests>=maxRequests)break;
        stats.aliasesSearched++;onEvent({type:'alias_start',roleId:role.id,roleLabel:role.label,alias,aliasDepth});
        try{await collectBucket({role,alias})}catch(e){if(['REQUEST_BUDGET','STOPPED'].includes(e.code))break;if(['RATE_LIMIT','CHECKPOINT','AUTH_REQUIRED'].includes(e.code)){onEvent({type:'halt',code:e.code,message:e.message});throw e}onEvent({type:'alias_error',roleId:role.id,alias,code:e.code||'ERROR',message:e.message})}
      }
    }catch(error){updateRequests();onEvent({type:'failure',stage:stats.stage,requests:stats.requests,code:error.code||null,message:error.message,session:this.client.sessionState?this.client.sessionState():null});throw error}
    finally{await this.client.close().catch(()=>{})}
    if(stopped()){updateRequests();stats.stopped=true;stats.stage='stopped';onEvent({type:'stopped',requests:stats.requests,session:this.client.sessionState?this.client.sessionState():null})}
    const uniq=new Map();for(const r of rows){const key=r.url;if(!key)continue;const e=uniq.get(key);if(!e)uniq.set(key,r);else{const aliases=new Set([e.matchedAlias,r.matchedAlias].filter(Boolean));uniq.set(key,{...e,...(r.headline?.length>e.headline?.length?r:{}),matchedAliases:[...aliases]})}}
    updateRequests();return{configured:true,rows:[...uniq.values()],stats}
  }
}
module.exports={LinkedInDirectError,LinkedInCircuitBreaker,LinkedInRateController,LinkedInDirectClient,LinkedInDirectCollector,makeVariables,parsePeople,parseCompanies,parseTotal,csrfValue,jsidBase,findChromium,persistentProfileDir};
