import { Router } from 'express';
import { EnrichmentRequestSchema } from '../../domain/enrichment.js';
import { EnrichmentService } from '../../domain/service.js';
import type { JobQueue } from '../../queue/jobQueue.js';
export function enrichmentRoutes(service: EnrichmentService, queue: JobQueue) {
  const router = Router();
  router.post('/v1/enrich', async (req, res, next) => {
    try { const parsed = EnrichmentRequestSchema.parse(req.body); const result = await service.submit(parsed.linkedinUrl); res.status(result.queued ? 202 : 200).json(result); }
    catch (e) { next(e); }
  });
  router.get('/v1/jobs/:id', async (req, res, next) => {
    try { const job = await queue.get(req.params.id); if (!job) return res.status(404).json({ error: 'Job not found' }); res.json(job); }
    catch (e) { next(e); }
  });
  return router;
}
