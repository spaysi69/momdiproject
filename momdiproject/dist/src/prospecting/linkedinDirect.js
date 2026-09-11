'use strict';

const {spawn}=require('node:child_process');
const fs=require('node:fs');

const DEFAULT_QUERY_IDS=[
  // Extracted from the current LinkedIn Android client (2026) and kept first.
  'voyagerSearchDashClusters.361bd1e06b8f11d329618f06a8d77fb7',
  // Verified live against web traffic in August 2026.
  'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0',
  // Older fallback still seen in open-source collectors.
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
function textValue(v){if(v==null)return'';if(typeof v==='string')return v;if(typeof v==='number')return String(v);if(typeof v==='object'){if(typeof v.text==='string')return v.text;if(typeof v.name==='string')return v.name}return''}
function pickText(obj,keys){for(const k of keys){const t=textValue(obj?.[k]);if(t)return t.trim()}return''}
function companyIdFromObject(o){const vals=[o?.entityUrn,o?.trackingUrn,o?.targetUrn,o?.urn,o?.companyUrn];for(const v of vals){const m=String(v||'').match(/urn:li:(?:fsd_)?company:(\d+)/i);if(m)return m[1]}return null}
function profileUrlFromObject(o){const vals=[o?.navigationUrl,o?.url,o?.profileUrl,o?.publicProfileUrl];for(const v of vals){const m=String(v||'').match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+/i);if(m)return m[0].replace(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com/i,'https://www.linkedin.com').replace(/\/$/,'')}const pid=o?.publicIdentifier||o?.publicId;return pid?`https://www.linkedin.com/in/${String(pid).replace(/^\/+|\/+$/g,'')}`:null}
function companyUrlFromObject(o){const vals=[o?.navigationUrl,o?.url,o?.companyUrl];for(const v of vals){const m=String(v||'').match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[^/?#]+/i);if(m)return m[0].replace(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com/i,'https://www.linkedin.com').replace(/\/$/,'')}return null}
function parseTotal(payload){let best=0;walk(payload,o=>{for(const k of ['totalResultCount','total','totalCount']){const n=Number(o?.[k]);if(Number.isFinite(n)&&n>best&&n<100000000)best=n}});return best}

function parsePeople(payload,{company='',query=''}={}){
  const map=new Map();
  walk(payload,o=>{
    const url=profileUrlFromObject(o);if(!url)return;
    const name=pickText(o,['title','name','fullName','firstName']);
    let headline=pickText(o,['primarySubtitle','headline','subtitle','occupation']);
    let location=pickText(o,['secondarySubtitle','location']);
    if(headline&&name&&norm(headline)===norm(name))headline='';
    if(!headline){for(const k of ['summary','description']){const t=textValue(o?.[k]);if(t&&t.length<240){headline=t;break}}}
    const existing=map.get(url);
    const row={engine:'linkedin-direct',query,url,title:name?`${name}${headline?` - ${headline}`:''}${company?` - ${company}`:''} | LinkedIn`:`${headline||query} | LinkedIn`,snippet:[headline,location,company].filter(Boolean).join(' · '),name:name||'',headline:headline||'',location:location||'',direct:true};
    if(!existing||row.title.length+row.snippet.length>existing.title.length+existing.snippet.length)map.set(url,row);
  });
  return [...map.values()];
}
function scoreCompanyName(targetRaw,nameRaw,slugRaw=''){
  const target=norm(targetRaw),n=norm(nameRaw),s=norm(String(slugRaw).replace(/-/g,' '));
  if(!target)return 0;
  if(n===target)return 100;
  if(s===target)return 99;
  if(n&&((n.includes(target)&&target.length>=3)||(target.includes(n)&&n.length>=3)))return 90;
  if(s&&((s.includes(target)&&target.length>=3)||(target.includes(s)&&s.length>=3)))return 88;
  const at=new Set(target.split(' ')),bt=new Set(`${n} ${s}`.split(' ').filter(Boolean));
  const hit=[...at].filter(x=>bt.has(x)).length;
  return at.size?Math.round(80*hit/at.size):0;
}
function parseCompanies(payload,company){
  const candidates=[];
  walk(payload,o=>{
    const id=companyIdFromObject(o),url=companyUrlFromObject(o);if(!id&&!url)return;
    const name=pickText(o,['title','name','companyName','primarySubtitle','universalName']);
    const slug=url?url.split('/company/')[1]?.split('/')[0]||'':String(o?.universalName||'');
    candidates.push({id,name:name||slug,url:url||null,slug,score:scoreCompanyName(company,name,slug)});
  });
  const uniq=new Map();
  for(const c of candidates){const key=c.id||c.url||c.slug;if(!key)continue;const e=uniq.get(key);if(!e||c.score>e.score)uniq.set(key,c)}
  return [...uniq.values()].sort((a,b)=>b.score-a.score);
}
function parseOrganizationCompany(payload,{slug='',company=''}={}){
  const rows=[];
  walk(payload,o=>{
    const id=companyIdFromObject(o);if(!id)return;
    const name=pickText(o,['name','companyName','title'])||company||slug;
    const universalName=String(o?.universalName||slug||'').trim();
    rows.push({id,name,slug:universalName,url:universalName?`https://www.linkedin.com/company/${universalName}`:null,score:scoreCompanyName(company,name,universalName)});
  });
  return rows.sort((a,b)=>b.score-a.score)[0]||null;
}
function slugifyCompany(company=''){return norm(company).replace(/\s+/g,'-')}
function slugCandidates(company=''){
  const explicit=String(company).match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1];
  if(explicit)return[explicit.toLowerCase()];
  const base=slugifyCompany(company);
  const stripped=base.replace(/-(corporation|corp|incorporated|inc|limited|ltd|llc|plc|group)$/,'');
  const candidates=[base,stripped,`${stripped}-corporation`,`${stripped}-inc`,`${stripped}-group`].filter(Boolean);
  return [...new Set(candidates)].slice(0,5);
}

function makeVariables({keywords='',companyId=null,start=0,count=25,resultType='PEOPLE',networkDepth=null,titleFilter='',companyAsUrn=false}){
  const qp=[];
  if(companyId){
    const val=companyAsUrn?`urn:li:fsd_company:${String(companyId).replace(/\D/g,'')}`:String(companyId).replace(/\D/g,'');
    qp.push(`(key:currentCompany,value:List(${val}))`);
  }
  qp.push(`(key:resultType,value:List(${resultType}))`);
  if(networkDepth)qp.push(`(key:network,value:List(${networkDepth}))`);
  if(titleFilter){const t=String(titleFilter).replace(/[(),]/g,' ').replace(/\s+/g,' ').trim();if(t)qp.push(`(key:title,value:List(${t}))`)}
  const kw=String(keywords||'').replace(/[(),]/g,' ').replace(/\s+/g,' ').trim();
  return `(start:${Math.max(0,start)},count:${Math.max(1,Math.min(50,count))},origin:FACETED_SEARCH,query:(${kw?`keywords:${kw},`:''}flagshipSearchIntent:SEARCH_SRP,queryParameters:List(${qp.join(',')}),includeFiltersInResponse:false))`;
}

function buildPeopleUiUrl({companyId,title='',page=1,networkDepth=null}){
  const u=new URL('https://www.linkedin.com/search/results/people/');
  u.searchParams.set('currentCompany',JSON.stringify([String(companyId)]));
  if(title)u.searchParams.set('titleFreeText',String(title));
  if(networkDepth)u.searchParams.set('network',JSON.stringify([String(networkDepth)]));
  u.searchParams.set('origin','FACETED_SEARCH');
  if(page>1)u.searchParams.set('page',String(page));
  return u.toString();
}
function buildCompanyUiUrl(company){
  const u=new URL('https://www.linkedin.com/search/results/companies/');
  u.searchParams.set('keywords',String(company));
  u.searchParams.set('origin','GLOBAL_SEARCH_HEADER');
  return u.toString();
}
function normalizeUiPeople(rows=[],{company='',query=''}={}){
  const map=new Map();
  for(const raw of rows||[]){
    const url=profileUrlFromObject({url:raw?.url});if(!url)continue;
    const lines=Array.isArray(raw.lines)?raw.lines.map(x=>String(x).trim()).filter(Boolean):String(raw?.text||'').split(/\n+/).map(x=>x.trim()).filter(Boolean);
    const filtered=lines.filter(x=>!(/^(Connect|Message|Follow|View profile|1st|2nd|3rd\+?|•)$/i.test(x))&&!/\bconnections?\b/i.test(x));
    const name=String(raw?.name||filtered[0]||'').trim();
    let headline=String(raw?.headline||filtered.find((x,i)=>i>0&&x.length>2&&x.length<180&&!sameLoose(x,name))||'').trim();
    let location=String(raw?.location||filtered.find(x=>/\b(United States|United Kingdom|India|Canada|Germany|France|Spain|Morocco|Area|Region|California|Texas|New York|London|Bengaluru|Seattle|Portland)\b/i.test(x))||'').trim();
    const text=String(raw?.text||filtered.join(' · ')).slice(0,1200);
    const row={engine:'linkedin-direct-ui',query,url,title:name?`${name}${headline?` - ${headline}`:''}${company?` - ${company}`:''} | LinkedIn`:`${headline||query} | LinkedIn`,snippet:text||[headline,location,company].filter(Boolean).join(' · '),name,headline,location,direct:true,ui:true};
    const old=map.get(url);if(!old||row.snippet.length>old.snippet.length)map.set(url,row);
  }
  return [...map.values()];
}
function sameLoose(a,b){return Boolean(norm(a)&&norm(a)===norm(b))}

class LinkedInDirectError extends Error{
  constructor(message,code='LINKEDIN_DIRECT_ERROR',meta={}){super(message);this.name='LinkedInDirectError';this.code=code;this.meta=meta}
}

class LinkedInCircuitBreaker{
  constructor(env=process.env){
    this.env=env;this.state='CLOSED';this.openedAt=null;this.nextAttemptAt=null;this.reason=null;this.consecutiveTransient=0;this.halfOpenProbe=false;
    this.transientThreshold=Math.max(1,Number(env.LINKEDIN_CIRCUIT_TRANSIENT_THRESHOLD||3));
    this.rateLimitCooldownMs=Math.max(60000,Number(env.LINKEDIN_CIRCUIT_RATE_LIMIT_COOLDOWN_MS||900000));
    this.authCooldownMs=Math.max(60000,Number(env.LINKEDIN_CIRCUIT_AUTH_COOLDOWN_MS||1800000));
    this.transientCooldownMs=Math.max(30000,Number(env.LINKEDIN_CIRCUIT_TRANSIENT_COOLDOWN_MS||120000));
  }
  #open(reason,cooldownMs){this.state='OPEN';this.openedAt=Date.now();this.nextAttemptAt=this.openedAt+cooldownMs;this.reason=reason;this.halfOpenProbe=false}
  assertCanRequest(){
    if(this.state!=='OPEN')return;
    if(Date.now()>=(this.nextAttemptAt||0)){this.state='HALF_OPEN';this.halfOpenProbe=true;return}
    throw new LinkedInDirectError(`LinkedIn Direct circuit is open after ${this.reason||'provider protection signal'}.`,'CIRCUIT_OPEN',{reason:this.reason,nextAttemptAt:this.nextAttemptAt});
  }
  success(){this.state='CLOSED';this.openedAt=null;this.nextAttemptAt=null;this.reason=null;this.consecutiveTransient=0;this.halfOpenProbe=false}
  failure(error){
    const code=String(error?.code||'');
    if(code==='RATE_LIMIT'){const retry=Number(error?.meta?.retryAfterMs||0);this.#open(code,Math.max(this.rateLimitCooldownMs,retry));return}
    if(['CHECKPOINT','AUTH_REQUIRED'].includes(code)){this.#open(code,this.authCooldownMs);return}
    if(code==='CIRCUIT_OPEN')return;
    const status=Number(error?.meta?.status||0);
    if(code==='HTTP_ERROR'&&status>=500){this.consecutiveTransient++;if(this.consecutiveTransient>=this.transientThreshold)this.#open(`HTTP_${status}`,this.transientCooldownMs)}
    else if(!['CHROMIUM_UNAVAILABLE','CHROMIUM_START_FAILED'].includes(code)){this.consecutiveTransient=0}
  }
  snapshot(){return{state:this.state,reason:this.reason,openedAt:this.openedAt?new Date(this.openedAt).toISOString():null,nextAttemptAt:this.nextAttemptAt?new Date(this.nextAttemptAt).toISOString():null,consecutiveTransient:this.consecutiveTransient}}
}
class LinkedInRateController{
  constructor(env=process.env){
    this.minDelayMs=Math.max(250,Number(env.LINKEDIN_RATE_MIN_DELAY_MS||1200));
    this.maxPerMinute=Math.max(1,Number(env.LINKEDIN_RATE_MAX_PER_MINUTE||20));
    this.maxPerHour=Math.max(this.maxPerMinute,Number(env.LINKEDIN_RATE_MAX_PER_HOUR||240));
    this.lastRequestAt=0;this.timestamps=[];this.penaltyMs=0;
  }
  #prune(now){this.timestamps=this.timestamps.filter(t=>now-t<3600000)}
  async beforeRequest(){
    let now=Date.now();this.#prune(now);const minute=this.timestamps.filter(t=>now-t<60000);
    let wait=Math.max(0,this.lastRequestAt+this.minDelayMs+this.penaltyMs-now);
    if(minute.length>=this.maxPerMinute)wait=Math.max(wait,minute[0]+60000-now);
    if(this.timestamps.length>=this.maxPerHour)wait=Math.max(wait,this.timestamps[0]+3600000-now);
    if(wait>0)await sleep(wait);
    now=Date.now();this.#prune(now);this.lastRequestAt=now;this.timestamps.push(now);
  }
  success(){this.penaltyMs=Math.max(0,Math.floor(this.penaltyMs*.5)-100)}
  failure(error){if(error?.code==='RATE_LIMIT')this.penaltyMs=Math.min(30000,Math.max(this.penaltyMs*2,this.minDelayMs*4));else if(error?.code==='HTTP_ERROR'&&Number(error?.meta?.status||0)>=500)this.penaltyMs=Math.min(10000,Math.max(this.penaltyMs*2,this.minDelayMs))}
  snapshot(){const now=Date.now();this.#prune(now);return{minDelayMs:this.minDelayMs,maxPerMinute:this.maxPerMinute,maxPerHour:this.maxPerHour,requestsLastMinute:this.timestamps.filter(t=>now-t<60000).length,requestsLastHour:this.timestamps.length,penaltyMs:this.penaltyMs,lastRequestAt:this.lastRequestAt?new Date(this.lastRequestAt).toISOString():null}}
}

class CdpConnection{
  constructor(wsUrl){this.wsUrl=wsUrl;this.ws=null;this.seq=0;this.pending=new Map();this.events=[]}
  async connect(){
    this.ws=new WebSocket(this.wsUrl);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('CDP websocket timeout')),10000);
      this.ws.onopen=()=>{clearTimeout(timer);resolve()};
      this.ws.onerror=()=>{clearTimeout(timer);reject(new Error('CDP websocket failed'))};
    });
    this.ws.onmessage=e=>{
      let m;try{m=JSON.parse(e.data)}catch{return}
      if(m.id&&this.pending.has(m.id)){const p=this.pending.get(m.id);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message||'CDP command failed')):p.resolve(m.result);return}
      this.events.push(m);if(this.events.length>1000)this.events.shift();
    };
    return this;
  }
  command(method,params={},sessionId){
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`))},25000);
      this.pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});
      this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
  }
  close(){try{this.ws?.close()}catch{}}
}

class LinkedInBrowserTransport{
  constructor(config){
    this.config=config;this.proc=null;this.cdp=null;this.sessionId=null;this.port=Number(process.env.LINKEDIN_CHROMIUM_DEBUG_PORT||9223);
    this.executable=findChromium();this.profileDir=persistentProfileDir();this.startedAt=null;this.reuseCount=0;this.csrf=null;
  }
  available(){return Boolean(this.executable&&globalThis.WebSocket)}
  running(){return Boolean(this.cdp&&this.proc&&!this.proc.killed)}
  async start(){
    if(this.running()){this.reuseCount++;return}
    if(this.cdp){this.cdp.close();this.cdp=null;this.sessionId=null}
    if(!this.available())throw new LinkedInDirectError('Chromium transport is unavailable.','CHROMIUM_UNAVAILABLE');
    const args=['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-background-networking','--disable-default-apps','--disable-extensions','--disable-sync','--metrics-recording-only',`--remote-debugging-port=${this.port}`,`--user-data-dir=${this.profileDir}`,'about:blank'];
    this.proc=spawn(this.executable,args,{stdio:'ignore'});
    this.proc.once('exit',()=>{this.proc=null;this.cdp?.close();this.cdp=null;this.sessionId=null});
    let info=null;
    for(let i=0;i<40;i++){
      try{const r=await fetch(`http://127.0.0.1:${this.port}/json/version`,{signal:AbortSignal.timeout(1000)});if(r.ok){info=await r.json();break}}catch{}
      await sleep(250);
    }
    if(!info?.webSocketDebuggerUrl)throw new LinkedInDirectError('Chromium DevTools endpoint did not start.','CHROMIUM_START_FAILED');
    this.cdp=await new CdpConnection(info.webSocketDebuggerUrl).connect();
    const target=await this.cdp.command('Target.createTarget',{url:'about:blank'});
    const attached=await this.cdp.command('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    this.sessionId=attached.sessionId;
    await this.cdp.command('Page.enable',{},this.sessionId);
    await this.cdp.command('Runtime.enable',{},this.sessionId);
    await this.cdp.command('Network.enable',{},this.sessionId);
    const csrf=csrfValue(this.config.jsessionid);
    await this.cdp.command('Network.setCookies',{cookies:[
      {name:'li_at',value:this.config.liAt,domain:'.linkedin.com',path:'/',secure:true,httpOnly:true,sameSite:'None'},
      {name:'JSESSIONID',value:`ajax:${jsidBase(this.config.jsessionid)}`,domain:'.linkedin.com',path:'/',secure:true,httpOnly:false,sameSite:'None'}
    ]},this.sessionId);
    await this.navigate('https://www.linkedin.com/feed/',1200);
    this.csrf=csrf;this.startedAt=new Date().toISOString();
  }
  async evaluate(expression){
    const r=await this.cdp.command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:false},this.sessionId);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.text||'Browser evaluation failed');
    return r.result?.value;
  }
  async navigate(url,waitMs=1200){
    if(!this.running()&&url!=='https://www.linkedin.com/feed/')await this.start();
    await this.cdp.command('Page.navigate',{url},this.sessionId);
    await sleep(waitMs);
    const href=await this.evaluate('location.href');
    if(/\/login|\/checkpoint|\/challenge/i.test(String(href)))throw new LinkedInDirectError('LinkedIn session reached a login/checkpoint page. Refresh LINKEDIN_LI_AT and LINKEDIN_JSESSIONID.','AUTH_REQUIRED',{url:href});
    return String(href);
  }
  async request(path){
    await this.start();
    const csrf=this.csrf;
    const expr=`(async()=>{const r=await fetch(${JSON.stringify(path)},{credentials:'include',headers:{'accept':'application/vnd.linkedin.normalized+json+2.1','csrf-token':${JSON.stringify(csrf)},'x-restli-protocol-version':'2.0.0','x-li-lang':'en_US'}});return {status:r.status,url:r.url,retryAfter:r.headers.get('retry-after'),text:await r.text()}})()`;
    try{const out=await this.evaluate(expr);return normalizeLinkedInResponse(out)}
    catch(error){if(!this.proc||this.proc.killed){this.cdp?.close();this.cdp=null;this.sessionId=null}throw error}
  }
  async searchCompaniesUi(company){
    await this.start();
    await this.navigate(buildCompanyUiUrl(company),1400);
    return this.evaluate(`(()=>{const out=[];const seen=new Set();for(const a of document.querySelectorAll('a[href*="/company/"]')){let href=a.href||'';const m=href.match(/https?:\\/\\/(?:[a-z]{2,3}\\.)?linkedin\\.com\\/company\\/([^/?#]+)/i);if(!m||seen.has(m[1]))continue;seen.add(m[1]);let node=a.closest('li')||a.closest('[data-view-name]')||a.parentElement;let text=(node?.innerText||a.innerText||'').replace(/\\s+/g,' ').trim();out.push({url:href,slug:m[1],name:(a.innerText||'').replace(/\\s+/g,' ').trim(),text:text.slice(0,900)});if(out.length>=30)break}return{url:location.href,rows:out,body:(document.body?.innerText||'').slice(0,4000)}})()`);
  }
  async searchPeopleUi({companyId,title='',page=1,networkDepth=null}){
    await this.start();
    await this.navigate(buildPeopleUiUrl({companyId,title,page,networkDepth}),1500);
    return this.evaluate(`(()=>{const out=[];const seen=new Set();const anchors=[...document.querySelectorAll('a[href*="/in/"]')];for(const a of anchors){let href=(a.href||'').split('?')[0];if(!/linkedin\\.com\\/in\\//i.test(href)||seen.has(href))continue;seen.add(href);let node=a.closest('li')||a.closest('[data-view-name*="search"]')||a.closest('div');let text=(node?.innerText||a.innerText||'').trim();if(text.length>1600)text=text.slice(0,1600);let lines=text.split(/\\n+/).map(x=>x.trim()).filter(Boolean);out.push({url:href,name:(a.innerText||'').trim(),text,lines});if(out.length>=40)break}const body=(document.body?.innerText||'').slice(0,8000);let total=0;const m=body.match(/(?:About\\s+)?([\\d,.]+)\\s+results?/i);if(m)total=Number(m[1].replace(/[,\\.](?=\\d{3}\\b)/g,''))||0;return{url:location.href,rows:out,total,body}})()`);
  }
  async close(){/* persistent session */ }
  async shutdown(){this.cdp?.close();this.cdp=null;this.sessionId=null;if(this.proc){try{this.proc.kill('SIGTERM')}catch{}this.proc=null}}
  snapshot(){return{persistent:true,profileDir:this.profileDir,running:this.running(),startedAt:this.startedAt,reuseCount:this.reuseCount}}
}

function normalizeLinkedInResponse(out){
  const status=Number(out?.status||0),url=String(out?.url||''),text=String(out?.text||'');
  const retrySecs=Number(String(out?.retryAfter||'').trim()),retryAfterMs=Number.isFinite(retrySecs)&&retrySecs>0?retrySecs*1000:0;
  if(status===429)throw new LinkedInDirectError('LinkedIn rate limit reached. Direct collection stopped.','RATE_LIMIT',{status,retryAfterMs});
  if(status===999)throw new LinkedInDirectError('LinkedIn rejected the request (999).','CHECKPOINT',{status});
  if(/\/checkpoint\/|\/challenge\/|\/login/i.test(url)||/checkpoint|security verification|challenge/i.test(text.slice(0,1000)))throw new LinkedInDirectError('LinkedIn requested login/checkpoint verification.','AUTH_REQUIRED',{status,url});
  if(status<200||status>=300)throw new LinkedInDirectError(`LinkedIn returned HTTP ${status}.`,'HTTP_ERROR',{status,url,body:text.slice(0,500)});
  let data;try{data=JSON.parse(text)}catch{throw new LinkedInDirectError('LinkedIn returned non-JSON search data.','BAD_RESPONSE',{status,url})}
  return{status,url,data};
}
class LinkedInFetchTransport{
  constructor(config){this.config=config}
  available(){return Boolean(this.config.liAt&&this.config.jsessionid)}
  async request(path){
    const csrf=csrfValue(this.config.jsessionid),cookie=`li_at=${this.config.liAt}; JSESSIONID="${csrf}"`;
    const r=await fetch(new URL(path,'https://www.linkedin.com'),{redirect:'manual',headers:{'accept':'application/vnd.linkedin.normalized+json+2.1','cookie':cookie,'csrf-token':csrf,'x-restli-protocol-version':'2.0.0','x-li-lang':'en_US','user-agent':UA,'referer':'https://www.linkedin.com/search/results/people/'},signal:AbortSignal.timeout(this.config.timeoutMs)});
    const text=await r.text();return normalizeLinkedInResponse({status:r.status,url:r.headers.get('location')||r.url,retryAfter:r.headers.get('retry-after'),text});
  }
  async close(){}
}

class LinkedInDirectClient{
  constructor(env=process.env){
    this.env=env;
    this.config={enabled:envBool(env.LINKEDIN_DIRECT_ENABLED,true),liAt:String(env.LINKEDIN_LI_AT||''),jsessionid:String(env.LINKEDIN_JSESSIONID||''),timeoutMs:Math.max(5000,Number(env.LINKEDIN_DIRECT_TIMEOUT_MS||25000)),queryIds:String(env.LINKEDIN_SEARCH_QUERY_ID||'').split(',').map(s=>s.trim()).filter(Boolean)};
    if(!this.config.queryIds.length)this.config.queryIds=DEFAULT_QUERY_IDS.slice();
    const wanted=String(env.LINKEDIN_DIRECT_TRANSPORT||'auto').toLowerCase();
    this.browser=new LinkedInBrowserTransport(this.config);this.fetchTransport=new LinkedInFetchTransport(this.config);
    this.transport=wanted==='fetch'?this.fetchTransport:wanted==='browser'?this.browser:(this.browser.available()?this.browser:this.fetchTransport);
    this.queryIdIndex=0;this.requestCount=0;this.rate=new LinkedInRateController(env);this.circuit=new LinkedInCircuitBreaker(env);
    this.preferredPeopleStrategy=null;this.preferredQueryId=null;this.preferredMode=null;
  }
  configured(){return this.config.enabled&&Boolean(this.config.liAt&&this.config.jsessionid)}
  transportName(){return this.transport===this.browser?'chromium-inpage':'authenticated-fetch'}
  sessionState(){return{transport:this.transportName(),persistentProfile:this.transport===this.browser?this.browser.snapshot():{persistent:false},circuit:this.circuit.snapshot(),rate:this.rate.snapshot(),requestCount:this.requestCount,preferredMode:this.preferredMode,preferredPeopleStrategy:this.preferredPeopleStrategy,preferredQueryId:this.preferredQueryId}}
  async #withRequest(fn){
    if(!this.configured())throw new LinkedInDirectError('LinkedIn Direct is not configured.','NOT_CONFIGURED');
    this.circuit.assertCanRequest();await this.rate.beforeRequest();this.requestCount++;
    try{const out=await fn();this.rate.success();this.circuit.success();return out}
    catch(e){this.rate.failure(e);this.circuit.failure(e);throw e}
  }
  async request(path){
    return this.#withRequest(async()=>{
      try{return await this.transport.request(path)}
      catch(e){
        if(this.transport===this.browser&&String(this.env.LINKEDIN_DIRECT_TRANSPORT||'auto').toLowerCase()==='auto'&&['CHROMIUM_UNAVAILABLE','CHROMIUM_START_FAILED'].includes(e.code)){
          this.transport=this.fetchTransport;return this.transport.request(path);
        }
        throw e;
      }
    });
  }
  async verify(){const r=await this.request('/voyager/api/me');return{ok:true,transport:this.transportName(),status:r.status,session:this.sessionState()}}

  async #graphqlSearch({keywords='',companyId=null,start=0,count=25,resultType='PEOPLE',networkDepth=null,strategy=null}){
    const baseStrategies=resultType==='PEOPLE'&&companyId?[
      {name:'title_numeric',keywords:'',titleFilter:keywords,companyAsUrn:false},
      {name:'keywords_numeric',keywords,titleFilter:'',companyAsUrn:false},
      {name:'keywords_urn',keywords,titleFilter:'',companyAsUrn:true}
    ]:[{name:'default',keywords,titleFilter:'',companyAsUrn:false}];
    const strategies=strategy&&strategy!=='ui'?baseStrategies.filter(x=>x.name===strategy):baseStrategies;
    const orderedStrategies=this.preferredPeopleStrategy&&!strategy?[...strategies].sort((a,b)=>Number(b.name===this.preferredPeopleStrategy)-Number(a.name===this.preferredPeopleStrategy)):strategies;
    let lastError=null,zeroResult=null;
    const ids=this.preferredQueryId&&!strategy?[this.preferredQueryId,...this.config.queryIds.filter(x=>x!==this.preferredQueryId)]:this.config.queryIds;
    for(const shape of orderedStrategies){
      for(const queryId of ids){
        const variables=makeVariables({keywords:shape.keywords,companyId,start,count,resultType,networkDepth,titleFilter:shape.titleFilter,companyAsUrn:shape.companyAsUrn});
        const path=`/voyager/api/graphql?variables=${encodeURIComponent(variables)}&queryId=${encodeURIComponent(queryId)}`;
        try{
          const r=await this.request(path);
          const people=resultType==='PEOPLE'?parsePeople(r.data,{query:keywords}):[];
          const companies=resultType==='COMPANIES'?parseCompanies(r.data,keywords):[];
          const out={...r,queryId,strategy:shape.name,total:parseTotal(r.data),people,companies,pageSizeHint:count};
          if((resultType==='PEOPLE'&&people.length)||(resultType==='COMPANIES'&&companies.length)){
            if(resultType==='PEOPLE'){this.preferredPeopleStrategy=shape.name;this.preferredQueryId=queryId;this.preferredMode='graphql'}
            return out;
          }
          zeroResult=out;
        }catch(e){
          lastError=e;
          if(e.code==='HTTP_ERROR'&&[400,404,410].includes(Number(e.meta?.status)))continue;
          throw e;
        }
      }
    }
    if(zeroResult)return zeroResult;
    throw lastError||new LinkedInDirectError('No LinkedIn search query ID succeeded.','QUERY_ID_FAILED');
  }

  async #uiPeopleSearch({keywords='',companyId,start=0,networkDepth=null}){
    if(!this.browser.available())return null;
    const page=Math.floor(Math.max(0,start)/10)+1;
    const raw=await this.#withRequest(()=>this.browser.searchPeopleUi({companyId,title:keywords,page,networkDepth}));
    const people=normalizeUiPeople(raw.rows,{query:keywords});
    if(people.length){this.preferredMode='ui';this.preferredPeopleStrategy='ui'}
    return{status:200,url:raw.url,data:null,queryId:null,strategy:'ui',total:Number(raw.total||0),people,companies:[],pageSizeHint:10,bodyPreview:String(raw.body||'').slice(0,500)};
  }

  async search({keywords='',companyId=null,start=0,count=25,resultType='PEOPLE',networkDepth=null,strategy=null}){
    if(resultType==='PEOPLE'&&companyId){
      if(strategy==='ui'||(!strategy&&this.preferredMode==='ui')){
        const ui=await this.#uiPeopleSearch({keywords,companyId,start,networkDepth});
        if(ui&&ui.people.length)return ui;
        if(strategy==='ui')return ui||{strategy:'ui',total:0,people:[],companies:[],pageSizeHint:10};
      }
      const g=await this.#graphqlSearch({keywords,companyId,start,count,resultType,networkDepth,strategy});
      if(g.people.length||start>0)return g;
      const ui=await this.#uiPeopleSearch({keywords,companyId,start,networkDepth});
      return ui||g;
    }
    return this.#graphqlSearch({keywords,companyId,start,count,resultType,networkDepth,strategy});
  }

  async #resolveCompanyBySlug(slug,company){
    const path=`/voyager/api/organization/companies?decoration=${encodeURIComponent('(entityUrn,name,universalName)')}&q=universalName&universalName=${encodeURIComponent(slug)}`;
    try{
      const r=await this.request(path);
      const row=parseOrganizationCompany(r.data,{slug,company});
      return row&&row.score>=45?row:null;
    }catch(e){
      if(e.code==='HTTP_ERROR'&&[400,404,410].includes(Number(e.meta?.status)))return null;
      throw e;
    }
  }
  async #resolveCompanyViaUi(company){
    if(!this.browser.available())return null;
    const raw=await this.#withRequest(()=>this.browser.searchCompaniesUi(company));
    const candidates=(raw.rows||[]).map(x=>({...x,score:scoreCompanyName(company,x.name,x.slug)})).sort((a,b)=>b.score-a.score);
    for(const c of candidates.slice(0,4)){
      if(c.score<45)continue;
      const resolved=await this.#resolveCompanyBySlug(c.slug,company);
      if(resolved)return{...resolved,resolution:'ui+organization'};
    }
    return null;
  }
  async resolveCompany(company){
    const explicit=String(company).match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1];
    if(explicit){
      const r=await this.#resolveCompanyBySlug(explicit,company);if(r)return{...r,resolution:'explicit-slug'};
    }
    const ui=await this.#resolveCompanyViaUi(company);if(ui)return ui;
    for(const slug of slugCandidates(company)){
      const r=await this.#resolveCompanyBySlug(slug,company);if(r)return{...r,resolution:'slug-probe'};
    }
    const g=await this.#graphqlSearch({keywords:company,resultType:'COMPANIES',count:10});
    const best=g.companies[0];
    if(!best||best.score<45)throw new LinkedInDirectError(`Could not resolve a LinkedIn company for "${company}".`,'COMPANY_NOT_FOUND',{candidates:g.companies.slice(0,5),slugCandidates:slugCandidates(company)});
    return{...best,totalCandidates:g.companies.length,queryId:g.queryId,resolution:'graphql'};
  }
  async close(){await this.browser.close()}
  async shutdown(){await this.browser.shutdown()}
}

class LinkedInDirectCollector{
  constructor({client=new LinkedInDirectClient(),env=process.env}={}){this.client=client;this.env=env;this.queue=Promise.resolve()}
  configured(){return this.client.configured()}
  capabilities(){return{configured:this.configured(),transport:this.configured()?this.client.transportName():null,requires:['LINKEDIN_LI_AT','LINKEDIN_JSESSIONID'],strategy:'multi-path authenticated LinkedIn: organization resolver + Voyager GraphQL + server-rendered People UI fallback + adaptive partitioning',session:this.client.sessionState?this.client.sessionState():null}}
  discover(args){const run=this.queue.then(()=>this._discover(args));this.queue=run.catch(()=>{});return run}
  async _discover({company,roles,onEvent=()=>{},onRow=()=>{},shouldStop=()=>false}){
    if(!this.configured())return{configured:false,rows:[],stats:{requests:0,buckets:0,partitions:0,partialBuckets:0}};
    const maxRequests=Math.max(10,Number(this.env.LINKEDIN_DIRECT_MAX_REQUESTS||120));
    const pageSize=Math.max(10,Math.min(50,Number(this.env.LINKEDIN_DIRECT_PAGE_SIZE||25)));
    const bucketCap=Math.max(pageSize,Number(this.env.LINKEDIN_DIRECT_BUCKET_CAP||900));
    const partitionAt=Math.max(pageSize*2,Number(this.env.LINKEDIN_DIRECT_PARTITION_AT||400));
    const aliasesPerRole=Math.max(1,Number(this.env.LINKEDIN_DIRECT_ALIASES_PER_ROLE||16));
    const minDelay=Math.max(0,Number(this.env.LINKEDIN_DIRECT_DELAY_MS||0));
    const uiMaxPages=Math.max(2,Number(this.env.LINKEDIN_UI_MAX_PAGES||20));
    const rows=[],hasRequestCounter=Number.isFinite(Number(this.client.requestCount)),requestBase=hasRequestCounter?Number(this.client.requestCount):0;
    const stats={requests:0,buckets:0,partitions:0,partialBuckets:0,company:null,transport:this.client.transportName(),aliasesSearched:0,stage:'starting',strategies:{},uiFallbacks:0,graphqlHits:0,uiHits:0};
    const updateRequests=()=>{stats.requests=hasRequestCounter?Math.max(0,Number(this.client.requestCount)-requestBase):stats.requests};
    const emitStage=stage=>{stats.stage=stage;updateRequests();onEvent({type:'direct_stage',stage,requests:stats.requests,session:this.client.sessionState?this.client.sessionState():null})};
    const stopped=()=>Boolean(shouldStop&&shouldStop());
    const stopNow=()=>{updateRequests();stats.stopped=true;stats.stage='stopped';onEvent({type:'stopped',requests:stats.requests,session:this.client.sessionState?this.client.sessionState():null});return{configured:true,rows:[],stats}};
    onEvent({type:'session_state',session:this.client.sessionState?this.client.sessionState():null});
    if(stopped())return stopNow();
    let resolved;
    try{
      if(typeof this.client.verify==='function'){emitStage('session verification');await this.client.verify();updateRequests();onEvent({type:'session_verified',requests:stats.requests,session:this.client.sessionState?this.client.sessionState():null})}
      if(stopped())return stopNow();
      emitStage('company resolution');
      resolved=await this.client.resolveCompany(company);
      updateRequests();stats.company=resolved;stats.session=this.client.sessionState?this.client.sessionState():null;
      onEvent({type:'company_resolved',company:resolved});
    }catch(error){
      updateRequests();stats.session=this.client.sessionState?this.client.sessionState():null;
      onEvent({type:'failure',stage:stats.stage,requests:stats.requests,code:error.code||null,message:error.message,session:stats.session});
      error.meta={...(error.meta||{}),stage:stats.stage,requests:stats.requests};throw error;
    }
    const budget=()=>{updateRequests();if(stats.requests>=maxRequests)throw new LinkedInDirectError('LinkedIn Direct request budget reached.','REQUEST_BUDGET',{maxRequests})};
    const doSearch=async params=>{
      if(stopped())throw new LinkedInDirectError('Prospecting stopped by user.','STOPPED');
      budget();if(stats.requests)await sleep(minDelay);emitStage('employee search');
      const r=await this.client.search({...params,companyId:resolved.id,count:pageSize,resultType:'PEOPLE'});
      if(!hasRequestCounter)stats.requests++;else updateRequests();
      stats.session=this.client.sessionState?this.client.sessionState():null;
      stats.strategies[r.strategy]=(stats.strategies[r.strategy]||0)+1;
      if(r.strategy==='ui'){stats.uiFallbacks++;if(r.people.length)stats.uiHits+=r.people.length}else if(r.people.length)stats.graphqlHits+=r.people.length;
      onEvent({type:'request',params,total:r.total,results:r.people.length,requestNo:stats.requests,strategy:r.strategy,queryId:r.queryId||null,session:stats.session});
      return r;
    };
    const collectBucket=async({role,alias,networkDepth=null})=>{
      if(stopped())return;
      stats.buckets++;
      const first=await doSearch({keywords:alias,start:0,networkDepth});
      if(stopped())return;
      const total=Number(first.total||0),seen=new Set();
      const add=page=>{
        let fresh=0;
        for(const p of page.people){
          if(stopped())break;
          if(p.url&&seen.has(p.url))continue;
          if(p.url)seen.add(p.url);fresh++;
          const row={...p,company,roleId:role.id,roleLabel:role.label,matchedAlias:alias,networkDepth,totalResultCount:total,searchStrategy:page.strategy};
          rows.push(row);onRow(row);
        }
        return fresh;
      };
      add(first);
      if(!first.people.length)return;

      // Large known GraphQL buckets are split by network depth.
      if(!networkDepth&&total>partitionAt){
        stats.partitions++;onEvent({type:'partition',roleId:role.id,alias,total,by:'networkDepth'});
        for(const depth of ['F','S','O']){
          if(stopped()||stats.requests>=maxRequests)break;
          try{await collectBucket({role,alias,networkDepth:depth})}catch(e){if(['REQUEST_BUDGET','STOPPED'].includes(e.code))break;throw e}
        }
        return;
      }

      // Server-rendered UI search has a 10-ish result page. Continue until exhausted.
      if(first.strategy==='ui'){
        let lastCount=first.people.length;
        for(let page=2;page<=uiMaxPages&&stats.requests<maxRequests&&!stopped();page++){
          if(lastCount===0)break;
          const r=await doSearch({keywords:alias,start:(page-1)*10,networkDepth,strategy:'ui'});
          const fresh=add(r);lastCount=r.people.length;
          if(!r.people.length||fresh===0||r.people.length<Math.min(10,Number(r.pageSizeHint||10)))break;
          if(page===uiMaxPages&&r.people.length>=10&&!networkDepth){
            stats.partitions++;onEvent({type:'partition',roleId:role.id,alias,total:total||seen.size,by:'networkDepth_after_ui_cap'});
            for(const depth of ['F','S','O']){
              if(stopped()||stats.requests>=maxRequests)break;
              try{await collectBucket({role,alias,networkDepth:depth})}catch(e){if(['REQUEST_BUDGET','STOPPED'].includes(e.code))break;throw e}
            }
          }
        }
        return;
      }

      const step=Math.max(1,Number(first.pageSizeHint||pageSize));
      const effective=total?Math.min(total,bucketCap):bucketCap;
      const pages=total?Math.ceil(effective/step):Math.ceil(bucketCap/step);
      for(let page=1;page<pages&&stats.requests<maxRequests&&!stopped();page++){
        const r=await doSearch({keywords:alias,start:page*step,networkDepth,strategy:first.strategy});
        const fresh=add(r);
        if(!r.people.length||fresh===0||r.people.length<step)break;
      }
      if(total>bucketCap){stats.partialBuckets++;onEvent({type:'partial_bucket',roleId:role.id,alias,networkDepth,total,cap:bucketCap})}
    };

    const aliasLists=roles.map(role=>({role,aliases:[...new Set(role.aliases)].slice(0,aliasesPerRole)})),aliasTasks=[];
    for(let depth=0;depth<aliasesPerRole;depth++)for(const entry of aliasLists)if(entry.aliases[depth])aliasTasks.push({role:entry.role,alias:entry.aliases[depth],aliasDepth:depth});
    try{
      for(const {role,alias,aliasDepth} of aliasTasks){
        if(stopped()||stats.requests>=maxRequests)break;
        stats.aliasesSearched++;onEvent({type:'alias_start',roleId:role.id,roleLabel:role.label,alias,aliasDepth});
        try{await collectBucket({role,alias})}
        catch(e){
          if(['REQUEST_BUDGET','STOPPED'].includes(e.code))break;
          if(['RATE_LIMIT','CHECKPOINT','AUTH_REQUIRED'].includes(e.code)){onEvent({type:'halt',code:e.code,message:e.message});throw e}
          onEvent({type:'alias_error',roleId:role.id,alias,code:e.code||'ERROR',message:e.message});
        }
      }
    }catch(error){
      updateRequests();onEvent({type:'failure',stage:stats.stage,requests:stats.requests,code:error.code||null,message:error.message,session:this.client.sessionState?this.client.sessionState():null});throw error;
    }finally{await this.client.close().catch(()=>{})}
    if(stopped()){updateRequests();stats.stopped=true;stats.stage='stopped';onEvent({type:'stopped',requests:stats.requests,session:this.client.sessionState?this.client.sessionState():null})}
    const uniq=new Map();
    for(const r of rows){
      const key=r.url;if(!key)continue;const e=uniq.get(key);
      if(!e)uniq.set(key,r);
      else{const aliases=new Set([...(e.matchedAliases||[e.matchedAlias]),...(r.matchedAliases||[r.matchedAlias])].filter(Boolean));uniq.set(key,{...e,...(String(r.headline||'').length>String(e.headline||'').length?r:{}),matchedAliases:[...aliases]})}
    }
    updateRequests();return{configured:true,rows:[...uniq.values()],stats};
  }
}

module.exports={
  LinkedInDirectError,LinkedInCircuitBreaker,LinkedInRateController,LinkedInDirectClient,LinkedInDirectCollector,
  makeVariables,parsePeople,parseCompanies,parseTotal,parseOrganizationCompany,normalizeUiPeople,
  buildPeopleUiUrl,buildCompanyUiUrl,slugCandidates,scoreCompanyName,
  csrfValue,jsidBase,findChromium,persistentProfileDir
};
