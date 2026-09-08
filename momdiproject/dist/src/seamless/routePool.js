'use strict';
const {seamlessCredentials}=require('../config/credentials');
const {SeamlessRestClient}=require('./restClient');

class SeamlessRoutePool{
  constructor(config,env=process.env,clientFactory=null){
    const found=seamlessCredentials(env);
    this.routes=found.routes.map((route,index)=>{
      const rest=clientFactory?clientFactory(route,index):new SeamlessRestClient(route.key,config.apiBaseUrl,config.requestTimeoutMs,null,{routeId:route.id,keySource:route.source});
      return{...route,client:rest,rest,lastCredits:null,lastCreditsAt:null,forcedExhausted:false};
    });
    this.routeMap=new Map(this.routes.map(r=>[r.id,r]));
  }
  get size(){return this.routes.length}
  clientFor(routeId){const route=this.routeMap.get(routeId)||this.routes[0];if(!route)throw new Error('No Seamless route is configured.');return route.rest}
  noteCredits(route,credits){if(Number.isFinite(credits?.creditsRemaining)){route.lastCredits=credits.creditsRemaining;route.lastCreditsAt=credits.observedAt;route.forcedExhausted=credits.creditsRemaining<=0}}
  markExhausted(routeId){const route=this.routeMap.get(routeId);if(route){route.forcedExhausted=true;route.lastCredits=0;route.lastCreditsAt=new Date().toISOString()}}
  async probeRoute(route){
    try{
      const credits=await route.rest.getCredits();this.noteCredits(route,credits);
      if(!Number.isFinite(credits.creditsRemaining))return{id:route.id,keySource:route.source,priority:route.priority,creditsRemaining:null,lastKnownCreditsRemaining:route.lastCredits,rateLimitRemaining:credits?.rateLimitRemaining??null,rateLimitReset:credits?.rateLimitReset??null,observedAt:null,status:'ERROR',fresh:false,error:'Seamless did not return X-PublicAPI-Credits on this fresh authenticated response.'};
      return{id:route.id,keySource:route.source,priority:route.priority,creditsRemaining:credits.creditsRemaining,lastKnownCreditsRemaining:route.lastCredits,rateLimitRemaining:credits.rateLimitRemaining??null,rateLimitReset:credits.rateLimitReset??null,observedAt:credits.observedAt,status:'READY',fresh:true};
    }catch(error){
      return{id:route.id,keySource:route.source,priority:route.priority,creditsRemaining:null,lastKnownCreditsRemaining:route.lastCredits,rateLimitRemaining:null,rateLimitReset:null,observedAt:null,status:'ERROR',fresh:false,error:error.message||String(error)};
    }
  }
  annotateUsage(items){
    let activeFound=false;
    return items.map(item=>{let usageState='STANDBY';if(item.status!=='READY')usageState='UNAVAILABLE';else if(item.creditsRemaining<=0)usageState='EXHAUSTED';else if(!activeFound){usageState='ACTIVE';activeFound=true}return{...item,usageState}});
  }
  async creditSnapshot(){return this.status()}
  async status(){
    let items=await Promise.all(this.routes.map(r=>this.probeRoute(r)));
    items=this.annotateUsage(items);
    const allFresh=items.length>0&&items.every(x=>x.status==='READY'&&x.fresh&&Number.isFinite(x.creditsRemaining));
    const total=allFresh?items.reduce((sum,x)=>sum+x.creditsRemaining,0):null;
    const usable=items.filter(x=>x.status==='READY');
    return{status:usable.length===items.length?'READY':usable.length?'DEGRADED':'ERROR',routes:items,totalCreditsRemaining:total,allFresh,organizationCount:items.length,activeRouteId:items.find(x=>x.usageState==='ACTIVE')?.id||null,observedAt:new Date().toISOString(),balanceSource:'X-PublicAPI-Credits'};
  }
  async chooseResearchRoute({afterRouteId=null}={}){
    let start=0;if(afterRouteId){const idx=this.routes.findIndex(r=>r.id===afterRouteId);start=idx>=0?idx+1:0}
    for(let i=start;i<this.routes.length;i++){
      const route=this.routes[i];if(route.forcedExhausted)continue;
      let credits;try{credits=await route.rest.getCredits();this.noteCredits(route,credits)}catch(error){throw new Error(`${route.source} credit preflight failed: ${error.message||error}. A lower-priority key was not used because exhaustion was not confirmed.`)}
      if(!Number.isFinite(credits.creditsRemaining))throw new Error(`${route.source} did not return a fresh X-PublicAPI-Credits balance. A lower-priority key was not used.`);
      if(credits.creditsRemaining>0)return route;
      route.forcedExhausted=true;
    }
    throw new Error('All configured Seamless organizations report 0 research credits.');
  }
}
module.exports={SeamlessRoutePool};
