'use strict';
const crypto=require('node:crypto');
const os=require('node:os');
const {safeJson}=require('../seamless/restClient');

class DiagnosticJournal{
  constructor({maxEvents=4000}={}){this.maxEvents=maxEvents;this.reset({reason:'startup'})}
  reset(meta={}){this.sessionId=crypto.randomUUID();this.startedAt=new Date().toISOString();this.seq=0;this.events=[];this.meta=safeJson(meta);return this.summary()}
  add(category,event,details={}){const row={seq:++this.seq,at:new Date().toISOString(),category:String(category||'app'),event:String(event||'event'),details:safeJson(details)};this.events.push(row);if(this.events.length>this.maxEvents)this.events.splice(0,this.events.length-this.maxEvents);return row}
  summary(){return{sessionId:this.sessionId,startedAt:this.startedAt,eventCount:this.events.length,meta:this.meta}}
  snapshot(extra={}){return{reportType:'Prospecting Beast deep diagnostic journal',sessionId:this.sessionId,startedAt:this.startedAt,generatedAt:new Date().toISOString(),eventCount:this.events.length,runtime:{node:process.version,platform:process.platform,arch:process.arch,hostname:os.hostname(),pid:process.pid,uptimeSeconds:Math.round(process.uptime())},meta:this.meta,...safeJson(extra),events:safeJson(this.events)}}
}
module.exports={DiagnosticJournal};
