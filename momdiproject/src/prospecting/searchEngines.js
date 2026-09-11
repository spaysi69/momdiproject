'use strict';
const {URL}=require('node:url');

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

function decodeEntities(s=''){
  return String(s)
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)))
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}
function stripTags(s=''){
  return decodeEntities(String(s)
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ').trim());
}
function normalizeLinkedInUrl(raw=''){
  try{
    const decoded=decodeEntities(String(raw));
    const m=decoded.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[^"'&<>\s/?#]+/i);
    if(!m)return null;
    const u=new URL(m[0]);u.protocol='https:';u.hostname='www.linkedin.com';u.search='';u.hash='';u.pathname=u.pathname.replace(/\/+$/,'');
    return u.toString();
  }catch{return null}
}
function unwrapDuck(url){
  try{const u=new URL(decodeEntities(url),'https://duckduckgo.com');const target=u.searchParams.get('uddg');return target?decodeURIComponent(target):u.href}catch{return url}
}
function unwrapYahoo(url){
  const raw=decodeEntities(String(url||''));
  const direct=normalizeLinkedInUrl(raw);if(direct)return direct;
  const m=raw.match(/\/RU=([^/]+)\//i);
  if(m){try{return decodeURIComponent(m[1])}catch{}}
  return raw;
}
function normalizeResult(r,engine,query){
  if(!r?.url)return null;
  const url=normalizeLinkedInUrl(r.url)||r.url;
  return{engine,query,url,title:stripTags(r.title),snippet:stripTags(r.snippet)};
}
async function fetchText(url,opts={}){
  const timeout=Number(process.env.PROSPECT_FETCH_TIMEOUT_MS||10000);
  const r=await fetch(url,{...opts,headers:{'User-Agent':UA,'Accept-Language':'en-US,en;q=0.8','Accept':opts.accept||'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',...(opts.headers||{})},signal:AbortSignal.timeout(timeout),redirect:'follow'});
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
  return r.text();
}
function uniqueLinkedIn(rows,limit){
  const out=[],seen=new Set();
  for(const r of rows){
    const url=normalizeLinkedInUrl(r.url);if(!url||seen.has(url))continue;
    seen.add(url);out.push({...r,url});if(out.length>=limit)break;
  }
  return out;
}
function parseAnchorLinkedIn(html,engine,query,limit=30,{unwrap=x=>x}={}){
  const rows=[];const re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;let m;
  while((m=re.exec(String(html)))&&rows.length<limit*5){
    let href=unwrap(m[1]);const url=normalizeLinkedInUrl(href);if(!url)continue;
    const title=stripTags(m[2]);if(!title)continue;
    rows.push(normalizeResult({url,title,snippet:''},engine,query));
  }
  return uniqueLinkedIn(rows.filter(Boolean),limit);
}

function parseBingRss(xml,query,limit=30){
  const out=[];const re=/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi;let m;
  while((m=re.exec(String(xml)))&&out.length<limit){
    const r=normalizeResult({title:m[1],url:decodeEntities(m[2].trim()),snippet:m[3]},'bing',query);
    if(r&&normalizeLinkedInUrl(r.url))out.push(r);
  }
  return uniqueLinkedIn(out,limit);
}
function parseBingHtml(html,query,limit=30){
  const out=[];const block=/<li[^>]+class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;let m;
  while((m=block.exec(String(html)))&&out.length<limit){
    const b=m[1],a=b.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)||b.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if(!a)continue;
    const sn=(b.match(/<p[^>]*>([\s\S]*?)<\/p>/i)||[])[1]||'';
    const r=normalizeResult({url:a[1],title:a[2],snippet:sn},'bing',query);
    if(r&&normalizeLinkedInUrl(r.url))out.push(r);
  }
  if(!out.length)return parseAnchorLinkedIn(html,'bing',query,limit);
  return uniqueLinkedIn(out,limit);
}
function parseDuckHtml(html,query,limit=30){
  const out=[];
  const re=/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;let m;
  while((m=re.exec(String(html)))&&out.length<limit){
    const href=unwrapDuck(m[1]);const r=normalizeResult({url:href,title:m[2],snippet:''},'duckduckgo',query);
    if(r&&normalizeLinkedInUrl(r.url))out.push(r);
  }
  if(!out.length)return parseAnchorLinkedIn(html,'duckduckgo',query,limit,{unwrap:unwrapDuck});
  return uniqueLinkedIn(out,limit);
}
function parseYahooHtml(html,query,limit=30){
  return parseAnchorLinkedIn(html,'yahoo',query,limit,{unwrap:unwrapYahoo});
}

async function bing(query,limit=30){
  const rssUrl=`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(50,limit)}&format=rss`;
  try{
    const xml=await fetchText(rssUrl,{accept:'application/rss+xml,application/xml,text/xml,*/*'});
    const rows=parseBingRss(xml,query,limit);if(rows.length)return rows;
  }catch{}
  const html=await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(50,limit)}`);
  return parseBingHtml(html,query,limit);
}
async function duckduckgo(query,limit=30){
  try{
    const html=await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    const rows=parseDuckHtml(html,query,limit);if(rows.length)return rows;
  }catch{}
  const lite=await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
  return parseAnchorLinkedIn(lite,'duckduckgo',query,limit,{unwrap:unwrapDuck});
}
async function yahoo(query,limit=30){
  const html=await fetchText(`https://search.yahoo.com/search?p=${encodeURIComponent(query)}&n=${Math.min(50,limit)}`);
  return parseYahooHtml(html,query,limit);
}
async function searxng(query,limit=30){
  const base=(process.env.SEARXNG_BASE_URL||'').trim().replace(/\/$/,'');if(!base)return[];
  const url=`${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=en-US&safesearch=0`;
  const text=await fetchText(url,{accept:'application/json'});let j;try{j=JSON.parse(text)}catch{throw new Error('Invalid SearXNG JSON response')}
  return uniqueLinkedIn((j.results||[]).map(x=>normalizeResult({url:x.url,title:x.title,snippet:x.content||''},'searxng',query)).filter(Boolean),limit);
}
function configuredEngines(){
  const base=(process.env.SEARXNG_BASE_URL||'').trim();
  const yahooEnabled=!/^(0|false|no|off)$/i.test(String(process.env.PROSPECT_YAHOO_ENABLED||'true'));
  return[...(base?['searxng']:[]),'bing','duckduckgo',...(yahooEnabled?['yahoo']:[])];
}
async function runEngine(engine,query,limit){
  if(engine==='searxng')return searxng(query,limit);
  if(engine==='bing')return bing(query,limit);
  if(engine==='duckduckgo')return duckduckgo(query,limit);
  if(engine==='yahoo')return yahoo(query,limit);
  throw new Error(`Unsupported engine ${engine}`);
}
module.exports={
  runEngine,configuredEngines,stripTags,decodeEntities,normalizeLinkedInUrl,
  parseBingRss,parseBingHtml,parseDuckHtml,parseYahooHtml,unwrapDuck,unwrapYahoo
};
