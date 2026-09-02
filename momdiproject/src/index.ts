import { createApp } from './app.js';
import { createRuntime } from './bootstrap.js';
import { logger } from './observability/logger.js';

const runtime = createRuntime();
const port = Number(process.env.PORT ?? 3000);
const app = createApp(runtime.redis, runtime.service, runtime.queue, runtime.scheduler, runtime.ipProbe);
const server = app.listen(port, '0.0.0.0', () => logger.info({ port }, 'HTTP server started'));

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down');
  server.close();
  await runtime.redis.quit();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
