import { Router } from 'express';
import type Redis from 'ioredis';
export function healthRoutes(redis: Redis) {
  const router = Router();
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  router.get('/ready', async (_req, res) => {
    try { await redis.ping(); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'not_ready' }); }
  });
  return router;
}
