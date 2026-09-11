'use strict';

function clean(value){return typeof value==='string'?value.trim():''}
function routeIdForSource(source){
  if(source==='SEAMLESS_API_KEY')return 'default';
  if(source.startsWith('SEAMLESS_API_KEY_'))return source.slice('SEAMLESS_API_KEY_'.length).toLowerCase();
  return source.toLowerCase();
}
function keyPriority(name){
  if(name==='SEAMLESS_API_KEY_PRIMARY')return 0;
  if(name==='SEAMLESS_API_KEY_SECONDARY')return 1;
  const m=name.match(/^SEAMLESS_API_KEY_(\d+)$/);if(m)return 10+Number(m[1]);
  if(name==='SEAMLESS_API_KEY')return 100;
  return 50;
}
function seamlessCredentials(env=process.env){
  const selected=clean(env.SEAMLESS_KEY_SOURCE);
  let candidates=[];
  if(clean(env.SEAMLESS_API_KEY))candidates.push('SEAMLESS_API_KEY');
  for(const name of Object.keys(env).filter(k=>/^SEAMLESS_API_KEY_[A-Z0-9_]+$/.test(k)&&clean(env[k])))if(!candidates.includes(name))candidates.push(name);
  candidates.sort((a,b)=>keyPriority(a)-keyPriority(b)||a.localeCompare(b));
  if(selected){
    if(!clean(env[selected]))throw new Error(`SEAMLESS_KEY_SOURCE points to ${selected}, but that variable is empty.`);
    candidates=candidates.filter(x=>x!==selected);candidates.unshift(selected);
  }
  if(!candidates.length)throw new Error('Configure at least one Seamless Public API v1 key in Render.');
  const seenKeys=new Set();const routes=[];
  for(const source of candidates){
    const key=clean(env[source]);if(!key||seenKeys.has(key))continue;seenKeys.add(key);
    routes.push({id:routeIdForSource(source),source,key,priority:routes.length});
  }
  return {routes};
}
function seamlessCredential(env=process.env){const {routes}=seamlessCredentials(env);const r=routes[0];return{source:r.source,key:r.key}}
module.exports={seamlessCredential,seamlessCredentials,routeIdForSource,keyPriority};
