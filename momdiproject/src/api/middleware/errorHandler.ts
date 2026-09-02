import type { ErrorRequestHandler } from 'express';
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const message = err instanceof Error ? err.message : 'Internal server error';
  if (res.headersSent) return;
  res.status(500).json({ error: message, requestId: req.header('x-request-id') ?? null });
};
