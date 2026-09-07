'use strict';
const {seamlessCredentials}=require('../config/credentials');
const {SeamlessRestClient}=require('./restClient');
class SeamlessRoutePool{
  constructor(config,env=process.env,clientFactory=null){
    const found=seamlessCredentials(env);this.requireUniqueEgress=found.requireUniqueEgress;this.checkUrl=(env.SEAMLESS_EGRESS_CHECK_URL||'https://api.ipify.org?format=json').trim();
    this.routes=found.routes.map((route,index)=>{const rest=clientFactory?clientFactory(route,index):new SeamlessRestClient(route.key,config.apiBaseUrl,config.requestTimeoutMs,null,{proxyUrl:route.proxyUrl,routeId:route.id,keySource:route.source});return{...route,client:rest,rest,lastCredits:null,lastCreditsAt:null,lastEgressIp:null,lastEgressAt:null,forcedExhausted:false}});
    this.routeMap=new Map(this.routes.map(r=>[r.id,r]));this.egressCacheAt=0;
  }
  get size(){return this.routes.length}
  clientFor(routeId){const route=this.routeMap.get(routeId)||this.routes[0];if(!route)throw new Error('No Seamless route is configured.');return route.rest}
  noteCredits(route,credits){if(Number.isFinite(credits?.creditsRemaining)){route.lastCredits=credits.creditsRemaining;route.lastCreditsAt=credits.observedAt;route.forcedExhausted=credits.creditsRemaining<=0}}
  markExhausted(routeId){const route=this.routeMap.get(routeId);if(route){route.forcedExhausted=true;route.lastCredits=0;route.lastCreditsAt=new Date().toISOString()}}
  async probeRoute(route,{egress=true}={}){
    let credits=null,error=null,egressIp=route.lastEgressIp,egressObservedAt=route.lastEgressAt;
    try{credits=await route.rest.getCredits();this.noteCredits(route,credits);if(!Number.isFinite(credits.creditsRemaining))error='Seamless did not return X-PublicAPI-Credits on the fresh authenticated response.'}catch(e){error=e.message||String(e)}
    if(egress){try{const x=await route.rest.getEgressIp(this.checkUrl);egressIp=x.ip;egressObservedAt=x.observedAt;route.lastEgressIp=egressIp;route.lastEgressAt=egressObservedAt}catch(e){if(this.requireUniqueEgress)error=error?`${error}; egress: ${e.message}`:`Egress check failed: ${e.message}`}}
    return{id:route.id,keySource:route.source,priority:route.priority,proxyConfigured:Boolean(route.proxyUrl),creditsRemaining:Number.isFinite(credits?.creditsRemaining)?credits.creditsRemaining:null,lastKnownCreditsRemaining:route.lastCredits,rateLimitRemaining:credits?.rateLimitRemaining??null,rateLimitReset:credits?.rateLimitReset??null,observedAt:Number.isFinite(credits?.creditsRemaining)?credits.observedAt:null,egressIp,egressObservedAt,status:error?'ERROR':'READY',error};
  }
  async creditSnapshot(){const items=await Promise.all(this.routes.map(r=>this.probeRoute(r,{egress:false})));const known=items.filter(x=>Number.isFinite(x.creditsRemaining));return{routes:items,totalCreditsRemaining:known.length?known.reduce((s,x)=>s+x.creditsRemaining,0):null,observedAt:new Date().toISOString()}}
  annotateUsage(items){
    let activeFound=false;
    return items.map(item=>{let usageState='STANDBY';if(item.status!=='READY')usageState='UNAVAILABLE';else if((item.creditsRemaining??0)<=0)usageState='EXHAUSTED';else if(!activeFound){usageState='ACTIVE';activeFound=true}return{...item,usageState}});
  }
  async status(){
    let items=await Promise.all(this.routes.map(r=>this.probeRoute(r)));items=this.annotateUsage(items);
    const valid=items.filter(x=>x.status==='READY');const known=valid.filter(x=>Number.isFinite(x.creditsRemaining));const total=known.reduce((sum,x)=>sum+x.creditsRemaining,0);
    const ips=items.map(x=>x.egressIp).filter(Boolean);const uniqueIps=new Set(ips);const uniqueEgressOk=!this.requireUniqueEgress||(items.every(x=>x.proxyConfigured&&x.egressIp)&&uniqueIps.size===items.length);
    return{status:valid.length===items.length&&uniqueEgressOk?'READY':'ERROR',routes:items,totalCreditsRemaining:known.length?total:null,organizationCount:items.length,activeRouteId:items.find(x=>x.usageState==='ACTIVE')?.id||null,uniqueEgressRequired:this.requireUniqueEgress,uniqueEgressVerified:items.length<=1?true:(ips.length===items.length&&uniqueIps.size===items.length),error:!uniqueEgressOk?'Configured Seamless routes are not verified on distinct egress IPs.':undefined};
  }
  async assertUniqueEgress(){
    if(!this.requireUniqueEgress||this.routes.length<=1)return true;const now=Date.now();
    if(now-this.egressCacheAt<300000){const ips=this.routes.map(r=>r.lastEgressIp);if(ips.every(Boolean)&&new Set(ips).size===ips.length)return true}
    const probes=await Promise.all(this.routes.map(async r=>{if(!r.proxyUrl)throw new Error(`${r.source} has no dedicated egress proxy configured.`);const x=await r.rest.getEgressIp(this.checkUrl);r.lastEgressIp=x.ip;r.lastEgressAt=x.observedAt;return x.ip;}));this.egressCacheAt=now;
    if(new Set(probes).size!==probes.length)throw new Error('Unique egress check failed: two Seamless API keys currently exit through the same public IP.');return true;
  }
  async chooseResearchRoute({afterRouteId=null}={}){
    await this.assertUniqueEgress();let start=0;if(afterRouteId){const idx=this.routes.findIndex(r=>r.id===afterRouteId);start=idx>=0?idx+1:0}
    for(let i=start;i<this.routes.length;i++){
      const route=this.routes[i];if(route.forcedExhausted)continue;
      let credits;try{credits=await route.rest.getCredits();this.noteCredits(route,credits)}catch(error){throw new Error(`${route.source} credit preflight failed: ${error.message||error}. Secondary was not used because PRIMARY availability was not conclusively exhausted.`)}
      if(!Number.isFinite(credits.creditsRemaining))throw new Error(`${route.source} did not return a fresh X-PublicAPI-Credits balance. Secondary was not used.`);
      if(credits.creditsRemaining>0)return route;
      route.forcedExhausted=true;
    }
    throw new Error('All configured Seamless organizations report 0 research credits.');
  }
}
module.exports={SeamlessRoutePool};
