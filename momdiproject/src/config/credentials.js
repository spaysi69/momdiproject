'use strict';
function seamlessCredential(env=process.env){
  const allowed=['SEAMLESS_API_KEY','SEAMLESS_API_KEY_PRIMARY','SEAMLESS_MCP_API_KEY'];
  const selected=(env.SEAMLESS_KEY_SOURCE||'').trim();
  if(selected&&!allowed.includes(selected))throw new Error(`SEAMLESS_KEY_SOURCE must be one of: ${allowed.join(', ')}`);
  const source=selected||allowed.find(name=>(env[name]||'').trim());
  if(!source||!(env[source]||'').trim())throw new Error('Configure a Seamless API key with Public API v1 access in Render.');
  return {source,key:env[source].trim()};
}
module.exports={seamlessCredential};
