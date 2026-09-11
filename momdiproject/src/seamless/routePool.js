'use strict';
const {seamlessCredentials}=require('../config/credentials');
const {SeamlessRestClient}=require('./restClient');

class SeamlessRoutePool{
  constructor(config,env=process.env,clientFactory=null,diagnostics=null){
    this.diagnostics=diagnostics||null;
    const found=seamlessCredentials(env);
    this.routes=found.routes.map((route,index)=>{
      const onDiagnostic=record=>this.event('provider_http','request_complete',record);
      const rest=clientFactory?clientFactory(route,index):new SeamlessRestClient(route.key,config.apiBaseUrl,config.requestTimeoutMs,null,{routeId:route.id,keySource:route.source,onDiagnostic});
      return{...route,client:rest,rest,lastCredits:null,lastCreditsAt:null,lastCreditDiagnostic:null,forcedExhausted:false};
    });
    this.routeMap=new Map(this.routes.map(r=>[r.id,r]));
    this.event('routing','routes_configured',{routes:this.routes.map(r=>({id:r.id,keySource:r.source,priority:r.priority})),count:this.routes.length});
  }
  event(category,event,details={}){try{return this.diagnostics?.add(category,event,details)}catch{return null}}
  get size(){return this.routes.length}
  clientFor(routeId){const route=this.routeMap.get(routeId)||this.routes[0];if(!route)throw new Error('No Seamless route is configured.');return route.rest}
  noteCredits(route,credits,context='provider_response'){
    if(Number.isFinite(credits?.creditsRemaining)){
      const previous=route.lastCredits;
      route.lastCredits=credits.creditsRemaining;route.lastCreditsAt=credits.observedAt;route.lastCreditDiagnostic=credits.diagnostic||null;route.forcedExhausted=credits.creditsRemaining<=0;
      this.event('credits','route_balance_observed',{context,routeId:route.id,keySource:route.source,previousCredits:Number.isFinite(previous)?previous:null,creditsRemaining:credits.creditsRemaining,deltaFromPrevious:Number.isFinite(previous)?previous-credits.creditsRemaining:null,observedAt:credits.observedAt,rateLimitRemaining:credits.rateLimitRemaining??null,rateLimitReset:credits.rateLimitReset??null,source:'X-PublicAPI-Credits'});
    }else this.event('credits','route_balance_missing',{context,routeId:route.id,keySource:route.source,observedAt:credits?.observedAt??null,source:'X-PublicAPI-Credits'});
  }
  markExhausted(routeId,reason='explicit_insufficient_credits'){const route=this.routeMap.get(routeId);if(route){route.forcedExhausted=true;route.lastCredits=0;route.lastCreditsAt=new Date().toISOString();this.event('routing','route_marked_exhausted',{routeId,keySource:route.source,reason})}}
  async probeRoute(route,cause='status'){
    this.event('credits','probe_started',{cause,routeId:route.id,keySource:route.source,priority:route.priority});
    try{
      const credits=await route.rest.getCredits();this.noteCredits(route,credits,`probe:${cause}`);
      if(!Number.isFinite(credits.creditsRemaining)){
        const out={id:route.id,keySource:route.source,priority:route.priority,creditsRemaining:null,lastKnownCreditsRemaining:route.lastCredits,rateLimitRemaining:credits?.rateLimitRemaining??null,rateLimitReset:credits?.rateLimitReset??null,observedAt:null,status:'ERROR',fresh:false,error:'Seamless did not return X-PublicAPI-Credits on this fresh authenticated response.'};
        this.event('credits','probe_completed',{cause,...out});return out;
      }
      const out={id:route.id,keySource:route.source,priority:route.priority,creditsRemaining:credits.creditsRemaining,lastKnownCreditsRemaining:route.lastCredits,rateLimitRemaining:credits.rateLimitRemaining??null,rateLimitReset:credits.rateLimitReset??null,observedAt:credits.observedAt,status:'READY',fresh:true};
      this.event('credits','probe_completed',{cause,...out});return out;
    }catch(error){
      const out={id:route.id,keySource:route.source,priority:route.priority,creditsRemaining:null,lastKnownCreditsRemaining:route.lastCredits,rateLimitRemaining:null,rateLimitReset:null,observedAt:null,status:'ERROR',fresh:false,error:error.message||String(error)};
      this.event('credits','probe_failed',{cause,...out,providerDiagnostic:error?.diagnostic||null});return out;
    }
  }
  annotateUsage(items){let activeFound=false;return items.map(item=>{let usageState='STANDBY';if(item.status!=='READY')usageState='UNAVAILABLE';else if(item.creditsRemaining<=0)usageState='EXHAUSTED';else if(!activeFound){usageState='ACTIVE';activeFound=true}return{...item,usageState}})}
  async creditSnapshot(cause='credit_snapshot'){return this.status(cause)}
  async status(cause='status'){
    const statusRunId=`status-${Date.now()}-${Math.random().toString(16).slice(2,8)}`;
    this.event('status','provider_status_started',{cause,statusRunId,routeCount:this.routes.length});
    let items=await Promise.all(this.routes.map(r=>this.probeRoute(r,cause)));
    items=this.annotateUsage(items);
    const allFresh=items.length>0&&items.every(x=>x.status==='READY'&&x.fresh&&Number.isFinite(x.creditsRemaining));
    const total=allFresh?items.reduce((sum,x)=>sum+x.creditsRemaining,0):null;
    const usable=items.filter(x=>x.status==='READY');
    const result={status:usable.length===items.length?'READY':usable.length?'DEGRADED':'ERROR',routes:items,totalCreditsRemaining:total,allFresh,organizationCount:items.length,activeRouteId:items.find(x=>x.usageState==='ACTIVE')?.id||null,observedAt:new Date().toISOString(),balanceSource:'X-PublicAPI-Credits',cause,statusRunId};
    this.event('status','provider_status_completed',{cause,statusRunId,result});
    return result;
  }
  async chooseResearchRoute({afterRouteId=null,cause='research_preflight'}={}){
    let start=0;if(afterRouteId){const idx=this.routes.findIndex(r=>r.id===afterRouteId);start=idx>=0?idx+1:0}
    this.event('routing','selection_started',{cause,afterRouteId,startIndex:start,candidates:this.routes.slice(start).map(r=>({id:r.id,keySource:r.source,priority:r.priority,forcedExhausted:r.forcedExhausted,lastCredits:r.lastCredits,lastCreditsAt:r.lastCreditsAt}))});
    for(let i=start;i<this.routes.length;i++){
      const route=this.routes[i];if(route.forcedExhausted){this.event('routing','candidate_skipped',{cause,routeId:route.id,reason:'forced_exhausted'});continue}
      let credits;try{credits=await route.rest.getCredits();this.noteCredits(route,credits,`route_selection:${cause}`)}catch(error){this.event('routing','selection_failed',{cause,routeId:route.id,keySource:route.source,reason:'credit_preflight_failed',message:error.message||String(error),providerDiagnostic:error?.diagnostic||null});throw new Error(`${route.source} credit preflight failed: ${error.message||error}. A lower-priority key was not used because exhaustion was not confirmed.`)}
      if(!Number.isFinite(credits.creditsRemaining)){this.event('routing','selection_failed',{cause,routeId:route.id,reason:'missing_credit_header'});throw new Error(`${route.source} did not return a fresh X-PublicAPI-Credits balance. A lower-priority key was not used.`)}
      if(credits.creditsRemaining>0){this.event('routing','route_selected',{cause,routeId:route.id,keySource:route.source,creditsRemaining:credits.creditsRemaining,observedAt:credits.observedAt});return route}
      route.forcedExhausted=true;this.event('routing','candidate_skipped',{cause,routeId:route.id,reason:'zero_credits',creditsRemaining:0});
    }
    this.event('routing','selection_failed',{cause,reason:'all_routes_exhausted'});throw new Error('All configured Seamless organizations report 0 research credits.');
  }
  diagnosticState(){return this.routes.map(r=>({id:r.id,keySource:r.source,priority:r.priority,lastCredits:r.lastCredits,lastCreditsAt:r.lastCreditsAt,forcedExhausted:r.forcedExhausted}))}
}
module.exports={SeamlessRoutePool};
