'use strict';
function emit(level,event,meta={}){const line=JSON.stringify({ts:new Date().toISOString(),level,event,...meta});(level==='error'?console.error:level==='warn'?console.warn:console.log)(line)}
module.exports={logger:{info:(e,m)=>emit('info',e,m),warn:(e,m)=>emit('warn',e,m),error:(e,m)=>emit('error',e,m)}};
