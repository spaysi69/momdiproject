import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../dist/src/server/app.js';
import {seamlessCredential} from '../dist/src/config/credentials.js';
import {readRpcResponse} from '../dist/src/mcp/seamlessMcp.js';

test('password gates workspace and scripts; reload always returns sign-in',async()=>{
 process.env.APP_AUTH_TOKEN='test-password-only';
 let providerCalls=0;
 const app=await createApp({status:async()=>{providerCalls++;throw Error('provider offline')},ready:async()=>{}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 try {
  const landing=await fetch(origin);const body=await landing.text();assert.match(body,/id="login-form"/);assert.doesNotMatch(body,/id="conversation"/);assert.equal(landing.headers.get('cache-control'),'no-store');
  for(const route of ['/workspace','/chatbox.html','/app.js','/status'])assert.equal((await fetch(origin+route)).status,401);
  assert.equal((await fetch(origin+'/auth/login',{method:'POST',headers:{Authorization:'Bearer wrong'}})).status,401);
  const headers={Authorization:'Bearer test-password-only'};
  assert.equal((await fetch(origin+'/auth/login',{method:'POST',headers})).status,200);assert.equal(providerCalls,0);
  const workspace=await fetch(origin+'/workspace',{headers});assert.equal(workspace.status,200);assert.match(await workspace.text(),/id="conversation"/);
  assert.equal((await fetch(origin+'/app.js',{headers})).status,200);
  assert.match(await (await fetch(origin)).text(),/id="login-form"/);
  assert.equal((await fetch(origin+'/v1/person/search',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('explicit server-key selection takes precedence without exposing another key',()=>{
 assert.deepEqual(seamlessCredential({SEAMLESS_MCP_API_KEY:' old ',SEAMLESS_API_KEY_PRIMARY:'new',SEAMLESS_MCP_KEY_SOURCE:'SEAMLESS_API_KEY_PRIMARY'}),{key:'new',source:'SEAMLESS_API_KEY_PRIMARY'});
 assert.equal(seamlessCredential({SEAMLESS_API_KEY_PRIMARY:'p',SEAMLESS_API_KEY_SECONDARY:'s'}).source,'SEAMLESS_API_KEY_PRIMARY');
 assert.throws(()=>seamlessCredential({SEAMLESS_MCP_KEY_SOURCE:'APP_AUTH_TOKEN',APP_AUTH_TOKEN:'secret'}),/supported/);
 assert.throws(()=>seamlessCredential({SEAMLESS_MCP_KEY_SOURCE:'SEAMLESS_API_KEY_SECONDARY',SEAMLESS_API_KEY_PRIMARY:'p'}),/Configure/);
});
test('403 reports missing scope only when provider says so',async()=>{
 const response=new Response(JSON.stringify({error:{message:'Required scope is missing'}}),{status:403,headers:{'Content-Type':'application/json'}});
 await assert.rejects(readRpcResponse(response,'id'),/missing the MCP scope/);
 await assert.rejects(readRpcResponse(new Response('denied',{status:403}),'id'),/exact reason was not supplied/);
});
