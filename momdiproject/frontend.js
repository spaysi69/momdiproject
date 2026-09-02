
const $=id=>document.getElementById(id);let authToken='';let resultCount=0;let selectedCompany=null;let selectedPerson=null;let selectedPersonTitle='';
function escapeHtml(v){return String(v??'').replace(/[&<>\'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function openAuthModal(message='Sign in to continue'){const m=$('authModal');m.classList.add('open');$('authError').textContent=message;setTimeout(()=>$('modalToken').focus(),0)}
async function api(path,options={}){const headers={'Content-Type':'application/json',Authorization:'Bearer '+authToken,...(options.headers||{})};let response;try{response=await fetch(path,{...options,headers})}catch(err){const e=new Error(`Network error: ${err?.message||'Unable to reach the server.'}`);e.kind='NETWORK';throw e}let body=null;let raw='';try{raw=await response.text();body=raw?JSON.parse(raw):null}catch{}if(!response.ok){const detail=body?.error||body?.message||raw?.slice(0,1200)||response.statusText||'No response body';const e=new Error(`[HTTP ${response.status}] ${detail}`);e.status=response.status;e.body=body;e.raw=raw;throw e}return body}
async function signIn(){authToken=$('modalToken').value.trim();$('authError').textContent='';if(!authToken)return;try{await api('/status');$('authModal').classList.remove('open');$('modalToken').value='';refreshStatus()}catch(err){authToken='';$('authError').textContent='That access code was rejected.'}}
$('modalSave').addEventListener('click',signIn);$('modalToken').addEventListener('keydown',e=>{if(e.key==='Enter')signIn()});
function showError(container,message){container.innerHTML='<div class="error">'+escapeHtml(message)+'</div>'}
function renderPerson(person,companies,cached){
 selectedPerson=person;
 const personBox=$('personResults');
 const companyBox=$('companyResults');
 if(!companies.length){
   personBox.innerHTML='<div class="person-card"><div class="person-avatar">'+escapeHtml((person.name||'P').slice(0,1).toUpperCase())+'</div><div><div class="search-name">'+escapeHtml(person.name||'LinkedIn profile')+'</div><div class="search-meta">'+escapeHtml(person.linkedinUrl||'')+'</div><div class="search-meta">'+(cached?'Loaded from saved profile data':'Profile looked up')+'</div></div></div>';
   companyBox.innerHTML='<div class="empty">No company records were returned for this person. Seamless may only have limited employment data for this profile.</div>';
   resetCompanySelection();
   return;
 }
 personBox.innerHTML='<div class="person-card"><div class="person-avatar">'+escapeHtml((person.name||'P').slice(0,1).toUpperCase())+'</div><div><div class="search-name">'+escapeHtml(person.name||'LinkedIn profile')+'</div><div class="search-meta">'+escapeHtml(person.linkedinUrl||'')+'</div><div class="search-meta">'+(cached?'Loaded from saved profile data':'Profile looked up')+'</div></div><div style="margin-left:auto" class="mini-badge">'+companies.length+' '+(companies.length===1?'record':'records')+'</div></div>';
 companyBox.innerHTML='<div class="career-intro">'+(companies.length===1?'Company record found':'Choose the company record for this person')+'</div><div class="career-list">'+companies.map((c,i)=>'<button class="career-card'+(c.current?' current':'')+'" data-i="'+i+'" type="button"><div class="career-main"><div class="career-name">'+escapeHtml(c.name)+'</div><div class="career-meta">'+escapeHtml(c.title||'Role not listed')+(c.current?' · Current':' · Previous')+'</div>'+(c.startDate||c.endDate?'<div class="career-dates">'+escapeHtml(c.startDate||'')+(c.endDate?' → '+escapeHtml(c.endDate):' → Present')+'</div>':'')+'</div><div class="career-arrow">→</div></button>').join('')+'</div>';
 companyBox.querySelectorAll('.career-card').forEach(btn=>btn.addEventListener('click',()=>selectCompany(companies[Number(btn.dataset.i)])));
 resetCompanySelection(false);
 if(companies.length===1) selectCompany(companies[0]);
}
function resetCompanySelection(clearCompanies=true){
 selectedCompany=null;selectedPersonTitle='';
 $('contactsStep').classList.remove('active');
 $('contactToolbar').style.display='none';$('contactsListWrap').style.display='none';
 if(clearCompanies)$('companyResults').innerHTML='<div class="empty" style="padding:18px 8px">Find a person to see the company records Seamless returned for them.</div>';
}
async function searchCompanies(){
 if(!authToken){openAuthModal();return}
 const url=$('companyQuery').value.trim();
 const valid=/^https?:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9-_%]+\/?$/i.test(url);
 if(!valid){showError($('personResults'),'Enter a valid LinkedIn person URL, for example https://www.linkedin.com/in/example/');return}
 selectedPerson=null;selectedCompany=null;selectedPersonTitle='';
 $('companyResults').innerHTML=''; $('contactsList').innerHTML=''; $('contactsStep').classList.remove('active'); $('contactStepNote').textContent='select a company record first'; $('enrichSelectedBtn').disabled=true;
 $('searchCompanyBtn').disabled=true; $('searchCompanyBtn').textContent='Searching…'; clearError();
 try{
   let data=await api('/v1/person/companies',{method:'POST',body:JSON.stringify({linkedinUrl:url})});
   if(data?.status==='processing'){
     $('companyResults').innerHTML='<div class="career-intro">Seamless is researching this person…</div><div class="career-list"><div class="career-card"><strong>Research running</strong><span>This is tracked server-side, so you can refresh or search another person without starting the job again.</span></div></div>';
     let tries=0;
     while(tries<18){
       await new Promise(r=>setTimeout(r,1500)); tries+=1;
       try{data=await api('/v1/person/companies/status',{method:'POST',body:JSON.stringify({linkedinUrl:url})});}
       catch(pollError){ if(pollError.status===503) continue; throw pollError; }
       if(data?.status==='done') break;
     }
     if(data?.status!=='done'){
       $('companyResults').innerHTML='<div class="career-intro">Research is still running in Seamless.</div><div class="career-list"><div class="career-card"><strong>Still processing</strong><span>The job remains saved on the server. Press “Find person” again later to resume it without submitting another research request.</span></div></div>';
       return;
     }
   }
   renderPerson(data.person||{linkedinUrl:url},data.companies||[],Boolean(data.cached));
   $('contactStepNote').textContent=data.cached?'loaded from saved data':'person found';
   showSuccess(data.cached?'Loaded from saved data.':'Person found. Choose the company record.');
 }catch(e){
   showError(e.message||'Person lookup failed.');
 }finally{
   $('searchCompanyBtn').disabled=false; $('searchCompanyBtn').textContent='Find person';
 }
}

async function selectCompany(company){
 selectedCompany=company; selectedPersonTitle=company.title||selectedPerson?.title||'';
 $('contactStepNote').textContent='company selected'; $('contactsStep').classList.add('active');
 $('contactToolbar').style.display='flex';$('contactsListWrap').style.display='block';
 $('selectedCompanyName').textContent=company.name;$('selectedCompanyMeta').textContent=[company.title,company.current?'Current':'Previous'].filter(Boolean).join(' · ')||'Selected company record';
 $('contactsList').innerHTML='<label class="contact-row selected"><input type="checkbox" checked disabled><div><div class="contact-name">'+escapeHtml(selectedPerson?.name||'LinkedIn profile')+'</div><div class="contact-info">'+escapeHtml(selectedPersonTitle||'Person from the LinkedIn profile')+'</div></div><div class="contact-company">'+escapeHtml(company.name)+'</div></label>';
 $('selectionNote').textContent='This is the same person you entered. Researching this company record uses 1 credit.';
 $('enrichSelectedBtn').disabled=false;$('enrichSelectedBtn').textContent='Enrich this person';
 $('companyResults').querySelectorAll('.career-card').forEach(card=>card.classList.toggle('selected',card.textContent.trim().startsWith(company.name)));
 $('contactsStep').scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('searchCompanyBtn').addEventListener('click',searchCompanies);$('companyQuery').addEventListener('keydown',e=>{if(e.key==='Enter')searchCompanies()});$('enrichSelectedBtn').addEventListener('click',enrichSelected);$('changeCompanyBtn').addEventListener('click',()=>{selectedCompany=null;selectedPersonTitle='';$('contactsStep').classList.remove('active');$('contactToolbar').style.display='none';$('contactsListWrap').style.display='none';$('companyResults').querySelectorAll('.career-card').forEach(card=>card.classList.remove('selected'));$('contactStepNote').textContent='waiting for company';$('companyQuery').focus()});
async function enrichSelected(){
 if(!authToken){openAuthModal();return}
 if(!selectedCompany||!selectedPerson){showError($('contactsList'), 'Choose a company record first.');return}
 const btn=$('enrichSelectedBtn');
 btn.disabled=true;btn.textContent='Enriching…';
 $('lastUpdated').textContent='Researching selected company record';
 try{
   const data=await api('/v1/enrich-person-company',{
     method:'POST',
     body:JSON.stringify({
       linkedinUrl:selectedPerson.linkedinUrl||$('companyQuery').value.trim(),
       personName:selectedPerson.name||'',
       companyName:selectedCompany.name||'',
       title:selectedPersonTitle||undefined
     })
   });
   const enriched=data.data||data.result||data;
   addResult(enriched, data.cached===true, data.source||'provider');
   $('lastUpdated').textContent=data.cached?'Loaded saved enrichment':'Enriched successfully';
   refreshStatus();
 }catch(e){
   if(e.status===401){authToken='';openAuthModal('That access code was rejected.');}
   else showError($('contactsList'), e.message||'Enrichment failed.');
 }finally{
   btn.disabled=false;btn.textContent='Enrich this person';
 }
}
function normalizeDisplayPhone(value){
 const raw=String(value??'').trim();
 if(!raw)return '';
 const cleaned=raw.replace(/[^0-9+]/g,'');
 if(/^0\+1/i.test(cleaned)){const tail=cleaned.slice(3).replace(/\D/g,'');if(tail)return '0+1'+tail;}
 const digits=raw.replace(/\D/g,'');
 if(!digits)return '';
 if(digits.length===10)return '0+1'+digits;
 if(digits.length===11&&digits.startsWith('1'))return '0+'+digits;
 if(raw.startsWith('+1')&&digits.startsWith('1'))return '0+'+digits;
 if(digits.startsWith('001')&&digits.length===12)return '0+'+digits.slice(2);
 return raw.startsWith('+')?'+'+digits:digits;
}
function addResult(data,cached=false,source='provider'){
 const scroll=$('resultsScroll');
 $('emptyState')?.remove();
 resultCount+=1;
 const entry=document.createElement('article');
 entry.className='result-entry new';
 const name=data.fullName||data.name||'Enriched person';
 const title=data.title||'';
 const company=data.company||selectedCompany?.name||'';
 const phone=normalizeDisplayPhone(data.phone);
 const fields=[['Email',data.email],['Phone',phone],['Company',company],['LinkedIn',data.linkedinUrl||selectedPerson?.linkedinUrl]].filter(([,v])=>v);
 entry.innerHTML='<div class="result-entry-header"><div><div class="result-index">Result '+resultCount+'</div><div class="result-meta">'+escapeHtml(selectedCompany?.name||company)+'</div></div><span class="badge">'+(cached?'Saved':'Fresh')+'</span></div><div class="result-body"><div class="identity"><div><h3 class="name">'+escapeHtml(name)+'</h3><p class="title">'+escapeHtml(title)+'</p></div></div><div class="facts">'+fields.map(([k,v])=>'<div class="fact"><span>'+escapeHtml(k)+'</span><strong>'+escapeHtml(v)+'</strong></div>').join('')+'</div><div class="selection-note">'+escapeHtml(source==='provider'?'Researched through the configured provider route.':'Loaded from saved enrichment data.')+'</div></div>';
 scroll.prepend(entry);
 requestAnimationFrame(()=>entry.classList.remove('new'));
 $('resultsCount').textContent=resultCount+' researched '+(resultCount===1?'contact':'contacts');
}
function updateSelection(){
 const ready=Boolean(selectedCompany&&selectedPerson);
 $('enrichSelectedBtn').disabled=!ready;
 if(ready)$('enrichSelectedBtn').textContent='Enrich this person';
}
function setServiceState(text,kind=''){const dot=document.querySelector('#serviceStatus .dot');dot.className='dot'+(kind?' '+kind:'');$('serviceStatus').lastElementChild.textContent=text}
async function refreshStatus(){if(!authToken){setServiceState('Sign in required','warn');return}try{const data=await api('/status');const routes=Array.isArray(data.routes)&&data.routes.length?data.routes:[data.route||{}];const route=routes[0]||{};const creditsRemaining=Number(data.creditsRemaining??routes.reduce((n,r)=>n+Number(r.creditsRemaining||0),0));const creditsLimit=Number(data.creditsLimit??routes.reduce((n,r)=>n+Number(r.creditsLimit||0),0));const rpmRemaining=Number(route.rpmRemaining??0);$('credits').textContent=Number.isFinite(creditsRemaining)?creditsRemaining.toLocaleString():'—';$('rpm').textContent=Number.isFinite(rpmRemaining)?rpmRemaining.toLocaleString():'—';$('routeId').textContent=routes.map(r=>r.id).filter(Boolean).join(' + ')||'primary';$('routeState').textContent=routes.map(r=>r.status||'UNKNOWN').join(' / ');const rpmLimit=Number(route.rpmLimit||0);const creditPct=creditsLimit?Math.round(creditsRemaining/creditsLimit*100):0;const rpmPct=rpmLimit?Math.round(rpmRemaining/rpmLimit*100):0;$('creditBar').style.width=Math.max(0,Math.min(100,creditPct))+'%';$('rpmBar').style.width=Math.max(0,Math.min(100,rpmPct))+'%';$('creditPct').textContent=creditPct+'%';$('rpmPct').textContent=rpmPct+'%';$('routeUpdated').textContent=new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});const available=routes.some(r=>r.status==='READY'&&Number(r.creditsRemaining||0)>0);if(creditsRemaining<=0)setServiceState('Credits exhausted','bad');else if(available)setServiceState('Operational');else setServiceState('No route available','warn');updateSelection()}catch(e){if(e.status===401){authToken='';setServiceState('Sign in required','warn');openAuthModal()}else setServiceState('Service unavailable','bad')}}
openAuthModal();setInterval(refreshStatus,10000);
