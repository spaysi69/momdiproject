'use strict';
const {URL}=require('node:url');

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36';
function stripTags(s=''){return decodeEntities(String(s).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())}
function decodeEntities(s=''){return String(s).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))}
function unwrapDuck(url){try{const u=new URL(url,'https://duckduckgo.com');const target=u.searchParams.get('uddg');return target?decodeURIComponent(target):u.href}catch{return url}}
function normalizeResult(r,engine,query){if(!r?.url)return null;return{engine,query,url:r.url,title:stripTags(r.title),snippet:stripTags(r.snippet)}}
async function fetchText(url,opts={}){const timeout=Number(process.env.PROSPECT_FETCH_TIMEOUT_MS||9000);const r=await fetch(url,{...opts,headers:{'User-Agent':UA,'Accept-Language':'en-US,en;q=0.8','Accept':opts.accept||'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',...(opts.headers||{})},signal:AbortSignal.timeout(timeout),redirect:'follow'});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.text()}

async function bing(query,limit=30){
  const url=`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(50,limit)}&format=rss`;
  const xml=await fetchText(url,{accept:'application/rss+xml,application/xml,text/xml,*/*'});const out=[];const re=/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi;let m;while((m=re.exec(xml))&&out.length<limit){const r=normalizeResult({title:m[1],url:decodeEntities(m[2].trim()),snippet:m[3]},'bing',query);if(r)out.push(r)}return out;
}
async function duckduckgo(query,limit=30){
  const url=`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;const html=await fetchText(url);const out=[];const blockRe=/<div[^>]+class="[^"]*result[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi;let block;while((block=blockRe.exec(html))&&out.length<limit){const b=block[0];const a=b.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)||b.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);if(!a)continue;const sn=(b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)||b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i)||[])[1]||'';const r=normalizeResult({url:unwrapDuck(decodeEntities(a[1])),title:a[2],snippet:sn},'duckduckgo',query);if(r)out.push(r)}return out;
}
async function searxng(query,limit=30){
  const base=(process.env.SEARXNG_BASE_URL||'').trim().replace(/\/$/,'');if(!base)return[];const url=`${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=en-US&safesearch=0`;const text=await fetchText(url,{accept:'application/json'});let j;try{j=JSON.parse(text)}catch{throw new Error('Invalid SearXNG JSON response')}return (j.results||[]).slice(0,limit).map(x=>normalizeResult({url:x.url,title:x.title,snippet:x.content||''},'searxng',query)).filter(Boolean);
}
function configuredEngines(){return (process.env.SEARXNG_BASE_URL||'').trim()?['searxng','bing','duckduckgo']:['bing','duckduckgo']}
async function runEngine(engine,query,limit){if(engine==='searxng')return searxng(query,limit);if(engine==='bing')return bing(query,limit);if(engine==='duckduckgo')return duckduckgo(query,limit);throw new Error(`Unsupported engine ${engine}`)}
module.exports={runEngine,configuredEngines,stripTags,decodeEntities};
