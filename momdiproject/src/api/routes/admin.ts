import { Router } from 'express';
import type { RouteScheduler } from '../../quota/scheduler.js';
import type { JobQueue } from '../../queue/jobQueue.js';
import type { EgressIpProbe } from '../../providers/seamless/client.js';

export function adminRoutes(scheduler: RouteScheduler, queue: JobQueue, ipProbe: EgressIpProbe) {
  const router = Router();
  router.get('/status', async (_req, res, next) => {
    try {
      const probe = await ipProbe.get();
      const current = await scheduler.getStatus();
      await Promise.all(current.map(route => scheduler.updateObservedEgressIp(route.routeId, probe.ip)));
      const routes = current.map(route => ({ ...route, observedEgressIp: probe.ip, lastIpCheckAt: probe.checkedAt, ipMatch: route.expectedEgressIp && probe.ip ? route.expectedEgressIp === probe.ip : null }));
      res.json({ routes, queue: await queue.stats(), observedEgressIp: probe.ip, lastIpCheckAt: probe.checkedAt });
    } catch (e) { next(e); }
  });
  router.post('/routes/:id/reset', async (req, res, next) => {
    try { await scheduler.reset(req.params.id); res.json({ ok: true, routeId: req.params.id }); }
    catch (e) { next(e); }
  });
  return router;
}
