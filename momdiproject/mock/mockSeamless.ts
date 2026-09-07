import express from 'express';
const app = express(); app.use(express.json());
const port = Number(process.env.MOCK_PORT ?? 4000); let count = 0;
app.post('/v1/enrich', (req,res)=>{ count++; if(!req.body?.linkedin_url) return res.status(400).json({error:'linkedin_url required'}); if(process.env.MOCK_MODE==='429') {res.set('Retry-After','2'); return res.status(429).json({error:'rate limit'})} if(process.env.MOCK_MODE==='500') return res.status(500).json({error:'server'}); const url=req.body.linkedin_url; const slug=url.split('/in/')[1]?.replace(/\/$/,'')??'unknown'; res.json({full_name:`Test ${slug}`,first_name:'Test',last_name:slug,title:'Software Engineer',company:'Example Corp',linkedin_url:url}); });
app.listen(port,()=>console.log(`Mock provider on ${port}; requests=${count}`));
