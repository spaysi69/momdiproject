import type { RequestHandler } from 'express';
export function bearerAuth(expected: string | undefined): RequestHandler {
  return (req, res, next) => {
    if (!expected) return res.status(503).json({ error: 'Authentication is not configured' });
    const header = req.header('authorization');
    if (header !== `Bearer ${expected}`) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
}
