'use strict';
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload()});
document.getElementById('login-form').addEventListener('submit',async event=>{
 event.preventDefault();
 const field=document.getElementById('password'),button=document.getElementById('login-submit'),error=document.getElementById('login-error');
 if(button.disabled)return;
 const password=field.value.trim();button.disabled=true;error.textContent='';
 try{
  const headers={Authorization:`Bearer ${password}`};
  const response=await fetch('/auth/login',{method:'POST',headers,cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok){const result=await response.json();throw new Error(response.status===401?'Incorrect password. Please try again.':result.error||'Sign-in unavailable.')}
  const [htmlResponse,scriptResponse]=await Promise.all([fetch('/workspace',{headers,cache:'no-store',signal:AbortSignal.timeout(15000)}),fetch('/app.js',{headers,cache:'no-store',signal:AbortSignal.timeout(15000)})]);
  if(!htmlResponse.ok||!scriptResponse.ok)throw new Error('Could not open the workspace. Please sign in again.');
  const html=await htmlResponse.text(),script=await scriptResponse.text();
  field.value='';window.__workspaceToken=password;
  document.body.className='';document.body.innerHTML=new DOMParser().parseFromString(html,'text/html').body.innerHTML;
  document.title='Beast · Enriching';
  const url=URL.createObjectURL(new Blob([script],{type:'text/javascript'}));
  const element=document.createElement('script');element.src=url;element.onload=()=>URL.revokeObjectURL(url);element.onerror=()=>location.replace('/');document.body.append(element);
 }catch(err){error.textContent=err.message;button.disabled=false;field.value='';field.focus()}
});
