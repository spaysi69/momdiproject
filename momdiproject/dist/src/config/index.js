'use strict';
const fs=require('node:fs');const path=require('node:path');
function loadConfig(env=process.env){
  let file={};try{file=JSON.parse(fs.readFileSync(path.resolve(process.cwd(),'config.json'),'utf8'))}catch{}
  const n=(v,f)=>{const x=Number(v??f);return Number.isFinite(x)?x:f};
  return {apiBaseUrl:(env.SEAMLESS_API_BASE_URL||file.apiBaseUrl||'https://api.seamless.ai/api/client/v1').replace(/\/$/,''),requestTimeoutMs:n(env.SEAMLESS_API_TIMEOUT_MS,file.requestTimeoutMs||30000),pollIntervalMs:Math.max(2000,n(env.SEAMLESS_POLL_INTERVAL_MS,file.pollIntervalMs||2500)),maxPolls:Math.max(1,n(env.SEAMLESS_MAX_POLLS,file.maxPolls||30))};
}
module.exports={loadConfig};
