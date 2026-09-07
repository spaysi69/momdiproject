'use strict';
const http=require('node:http');
const https=require('node:https');
const tls=require('node:tls');

function headerBag(headers){
  const map=new Map();for(const [k,v] of Object.entries(headers||{}))map.set(k.toLowerCase(),Array.isArray(v)?v.join(', '):String(v));
  return{get(name){return map.get(String(name).toLowerCase())??null}};
}
function proxyAuth(proxy){
  if(!proxy.username&&!proxy.password)return null;
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
}
function collect(res,resolve,reject){
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode||0,headers:headerBag(res.headers),text:async()=>Buffer.concat(chunks).toString('utf8')}));res.on('error',reject);
}
function requestDirect(url,init={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);const lib=target.protocol==='https:'?https:http;
    const req=lib.request(target,{method:init.method||'GET',headers:init.headers||{}},res=>collect(res,resolve,reject));
    const abort=()=>req.destroy(Object.assign(new Error('Aborted'),{name:'AbortError'}));
    if(init.signal){if(init.signal.aborted)return abort();init.signal.addEventListener('abort',abort,{once:true});req.on('close',()=>init.signal.removeEventListener('abort',abort));}
    req.on('error',reject);if(init.body)req.write(init.body);req.end();
  });
}
function requestViaProxy(url,init={},proxyUrl){
  const target=new URL(url);if(target.protocol!=='https:')throw new Error('Per-key egress proxy currently supports HTTPS targets only.');
  const proxy=new URL(proxyUrl);if(!['http:','https:'].includes(proxy.protocol))throw new Error('Egress proxy URL must use http:// or https://');
  return new Promise((resolve,reject)=>{
    const connectHeaders={Host:`${target.hostname}:${target.port||443}`};const auth=proxyAuth(proxy);if(auth)connectHeaders['Proxy-Authorization']=auth;
    const connector=proxy.protocol==='https:'?https:http;
    const connectReq=connector.request({host:proxy.hostname,port:Number(proxy.port)|| (proxy.protocol==='https:'?443:80),method:'CONNECT',path:`${target.hostname}:${target.port||443}`,headers:connectHeaders});
    const abort=()=>connectReq.destroy(Object.assign(new Error('Aborted'),{name:'AbortError'}));
    if(init.signal){if(init.signal.aborted)return abort();init.signal.addEventListener('abort',abort,{once:true});}
    connectReq.on('connect',(res,socket,head)=>{
      if(res.statusCode!==200){socket.destroy();return reject(new Error(`Egress proxy CONNECT failed with HTTP ${res.statusCode}.`));}
      if(head?.length)socket.unshift(head);
      const secure=tls.connect({socket,servername:target.hostname});
      secure.once('error',reject);
      secure.once('secureConnect',()=>{
        const req=https.request({host:target.hostname,port:Number(target.port)||443,path:target.pathname+target.search,method:init.method||'GET',headers:{Host:target.host,...(init.headers||{})},createConnection:()=>secure,agent:false},r=>collect(r,resolve,reject));
        const abortInner=()=>req.destroy(Object.assign(new Error('Aborted'),{name:'AbortError'}));
        if(init.signal){if(init.signal.aborted)return abortInner();init.signal.addEventListener('abort',abortInner,{once:true});req.on('close',()=>init.signal.removeEventListener('abort',abortInner));}
        req.on('error',reject);if(init.body)req.write(init.body);req.end();
      });
    });
    connectReq.on('error',reject);connectReq.end();
  });
}
function transportFetch(url,init={},proxyUrl=null){return proxyUrl?requestViaProxy(url,init,proxyUrl):requestDirect(url,init)}
module.exports={transportFetch,requestViaProxy,requestDirect};
