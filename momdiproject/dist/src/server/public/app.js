'use strict';
const $=id=>document.getElementById(id);
const state={token:window.__workspaceToken||'',busy:false,profiles:new Map(),active:new Set(),confirm:new Set(),credits:null};
delete window.__workspaceToken;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let toastTimer;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000)}
function scrollBottom(){window.scrollTo({top:document.body.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})}
async function api(path,body){
  if(!state.token){location.replace('/');throw new Error('Enter your password to open the app.');}
  const response=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${state.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(65000)});
  let result;try{result=await response.json()}catch{throw new Error('The server did not return a readable response.');}
  if(!response.ok)throw new Error(result.error||'The request could not be completed.');
  return result;
}
function message(text,user=false){const el=document.createElement('div');el.className='message '+(user?'user-message':'assistant-message');if(user)el.textContent=text;else el.innerHTML='<div class="assistant-mark" aria-hidden="true">✧</div><div class="message-content"><p>'+esc(text)+'</p></div>';$('conversation').append(el);$('welcome').hidden=true;return user?el:el.querySelector('.message-content')}
function validLinkedIn(value){try{const u=new URL(value);if(u.protocol!=='https:'||!['linkedin.com','www.linkedin.com'].includes(u.hostname)||!/^\/in\/[^/]+\/?$/i.test(u.pathname))throw Error();return u.href}catch{return null}}
function setCredits(value){if(value===undefined)return;state.credits=value;if(value===null){$('credits').hidden=true;return;}$('credits').hidden=false;$('credits').textContent=`Credits: ${value}`;$('credits-content').innerHTML=`<p>Remaining research credits: <strong>${esc(value)}</strong></p><p class="fineprint">This number comes from Seamless's X-PublicAPI-Credits response header.</p>`}
function contactFields(d){
  const fields=[['Email',d.email],['Phone',d.phone],['Title',d.title],['Company',d.company],['Department',d.department],['Seniority',d.seniority],['LinkedIn',d.linkedinUrl]];
  return fields.filter(([,v])=>v).map(([label,value])=>`<div class="contact-field"><span>${esc(label)}</span>${label==='LinkedIn'?`<a href="${esc(value)}" target="_blank" rel="noreferrer">${esc(value)}</a>`:`<div class="value">${esc(value)}</div>`}${!['Title','Company','Department','Seniority'].includes(label)?`<button class="copy" data-copy="${esc(value)}" aria-label="Copy ${esc(label.toLowerCase())}">Copy</button>`:''}</div>`).join('');
}
function profileCard(url,job){
  const d=job?.data||{};const busy=state.active.has(url);const confirmed=state.confirm.has(url);const initial=(d.fullName||d.company||'in').slice(0,1).toUpperCase();
  let action='';let extra='';
  if(job?.status==='done'){
    action='<span class="saved-label">Saved ✓</span>';
    extra=`<div class="contacts">${contactFields(d)||'<div class="research-note">No contact fields were returned.</div>'}</div>`;
  }else if(['processing','submitting'].includes(job?.status)){
    action=`<button class="enrich-button" data-check="${esc(url)}" ${busy?'disabled':''}>${busy?'Checking…':'Check progress'}</button>`;
    extra='<div class="research-note">Seamless research is in progress. Polling does not consume research credits.</div>';
  }else if(job&&['missing','duplicate','failed','needs_review'].includes(job.status)){
    action='<span class="saved-label">Needs attention</span>';
    extra=`<div class="research-note error">${esc(job.message||`Research ended with status: ${job.status}.`)}</div>`;
  }else if(confirmed){
    action='<span class="saved-label">Confirm below</span>';
    extra=`<div class="research-note"><span>Submit this LinkedIn profile to Seamless research? Provider research can consume credits. Deduplication stays enabled.</span><span><button data-confirm="${esc(url)}">Confirm</button> <button data-cancel="${esc(url)}" aria-label="Cancel enrichment">×</button></span></div>`;
  }else{
    action=`<button class="enrich-button" data-enrich="${esc(url)}" ${busy?'disabled':''}>${busy?'Submitting…':'Enrich contact ↗'}</button><small>Research may use credits</small>`;
  }
  return `<article class="company-card"><div class="company-top"><div class="company-initial">${esc(initial)}</div><div class="company-text"><h3>${esc(d.fullName||'LinkedIn profile ready')}</h3><p>${esc(d.title||'Direct profile research')}${d.company?' · '+esc(d.company):''}</p></div><div class="company-action">${action}</div></div>${extra}</article>`;
}
function renderProfile(url){
  const item=state.profiles.get(url);if(!item)return;const job=item.job;
  if(job?.creditsRemaining!==undefined)setCredits(job.creditsRemaining);
  let intro,tag;
  if(job?.status==='done'){
    intro=`<p><strong>${esc(job.data?.fullName||'Contact')}</strong> is already saved. I loaded the enrichment without submitting another research request.</p>`;
    tag='<span class="source-tag">↳ Loaded from Supabase · 0 new research requests</span>';
  }else if(job){
    intro='<p>This LinkedIn profile already has a saved research state. No duplicate submission was made automatically.</p>';
    tag='<span class="source-tag">↳ Saved state from Supabase</span>';
  }else{
    intro='<p>This profile is not enriched yet. The link is ready for direct Seamless research.</p>';
    tag='<span class="source-tag">✓ Supabase checked · no provider research yet</span>';
  }
  item.container.innerHTML=`${intro}${tag}<div class="company-cards">${profileCard(url,job)}</div>`;
}
$('chat-form').addEventListener('submit',async e=>{
  e.preventDefault();if(state.busy)return;const raw=$('linkedin').value.trim();const url=validLinkedIn(raw);if(!url)return toast('Paste a LinkedIn person profile URL starting with https://www.linkedin.com/in/.');
  state.busy=true;$('send').disabled=true;message(url,true);const content=message('Checking Supabase for a saved enrichment…');content.querySelector('p').className='loading';$('linkedin').value='';scrollBottom();
  try{const result=await api('/v1/person/lookup',{linkedinUrl:url});const normalized=result.linkedinUrl;state.profiles.set(normalized,{...result,job:result.job,container:content});renderProfile(normalized)}
  catch(err){content.innerHTML=`<p class="error-text">${esc(err.message)}</p>`;$('linkedin').value=url}
  finally{state.busy=false;$('send').disabled=false;scrollBottom();$('linkedin').focus()}
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function runResearch(url,submit){
  const item=state.profiles.get(url);if(!item||state.active.has(url))return;state.active.add(url);state.confirm.delete(url);renderProfile(url);
  try{
    let job=await api(submit?'/v1/person/research':'/v1/person/research/status',{linkedinUrl:url});item.job=job;renderProfile(url);
    for(let i=0;i<30&&['submitting','processing'].includes(job.status);i++){await wait(2500);job=await api('/v1/person/research/status',{linkedinUrl:url});item.job=job;renderProfile(url)}
    if(job.status==='done')toast('Contact details saved. Future lookups will use Supabase.');else if(['submitting','processing'].includes(job.status))toast('Research is still processing. You can check again later.');else if(job.message)toast(job.message);
  }catch(err){toast(err.message);try{item.job=await api('/v1/person/research/status',{linkedinUrl:url})}catch{/* The backend intentionally prevents blind resubmission when provider outcome is uncertain. */}}
  finally{state.active.delete(url);renderProfile(url);scrollBottom()}
}
$('conversation').addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.copy!==undefined){try{await navigator.clipboard.writeText(b.dataset.copy);toast('Copied')}catch{toast('Copy is unavailable in this browser.')}}if(b.dataset.enrich){state.confirm.add(b.dataset.enrich);renderProfile(b.dataset.enrich)}if(b.dataset.cancel){state.confirm.delete(b.dataset.cancel);renderProfile(b.dataset.cancel)}if(b.dataset.confirm)runResearch(b.dataset.confirm,true);if(b.dataset.check)runResearch(b.dataset.check,false)});
function view(prospecting){$('enriching-view').hidden=prospecting;$('prospecting-view').hidden=!prospecting;$('enriching-nav').classList.toggle('active',!prospecting);$('prospecting-nav').classList.toggle('active',prospecting);$('enriching-nav').setAttribute('aria-current',prospecting?'false':'page');$('prospecting-nav').setAttribute('aria-current',prospecting?'page':'false');$('page-label').textContent=prospecting?'Prospecting':'Enriching'}
$('enriching-nav').onclick=()=>view(false);$('prospecting-nav').onclick=()=>view(true);$('back').onclick=()=>view(false);
async function checkConnection(){
  $('connect').disabled=true;
  try{
    const result=await api('/status');const errors=[];
    if(result.database?.status!=='READY')errors.push(result.database?.error||'Supabase is unavailable.');
    if(result.seamless?.status!=='READY')errors.push((result.keySource?`Selected server key: ${result.keySource}. `:'')+(result.seamless?.error||'Seamless REST is unavailable.'));
    $('connection-label').textContent=errors.length?'Connection needs attention':'Connected';$('connect').classList.toggle('connected',!errors.length);
    if(result.credits)setCredits(result.credits.creditsRemaining);
    if(result.credits){$('credits-content').innerHTML=`<p>Remaining research credits: <strong>${esc(result.credits.creditsRemaining??'Not reported')}</strong></p><p>REST rate-limit requests remaining: <strong>${esc(result.credits.rateLimitRemaining??'Not reported')}</strong></p><p class="fineprint">Credit balance is read from the X-PublicAPI-Credits header on a no-research org-data request.</p>`;}
    if(errors.length){const content=message(errors.join(' '));content.querySelector('p').className='error-text';}
  }catch(err){$('connection-label').textContent='Connection needs attention';const content=message(err.message);content.querySelector('p').className='error-text';}
  finally{$('connect').disabled=false;}
}
$('connect').onclick=checkConnection;$('credits').onclick=()=>$('credits-dialog').showModal();$('credits-close').onclick=()=>$('credits-dialog').close();
fetch('/health',{cache:'no-store'}).then(r=>r.json()).then(build=>{$('build-label').textContent=`v${build.version} · ${build.buildId}`}).catch(()=>{$('build-label').textContent='Version unavailable'});
$('logout').onclick=()=>{state.token='';location.replace('/')};
checkConnection();
