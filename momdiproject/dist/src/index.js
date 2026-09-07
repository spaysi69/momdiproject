"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./server/app");
const logger_1 = require("./utils/logger");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
(0, app_1.createApp)().then(app => {
    const server = app.listen(port, '0.0.0.0', () => logger_1.logger.info('server.started', { port }));
    const shutdown = (signal) => {
        logger_1.logger.info('server.shutdown', { signal });
        server.close(err => {
            if (err) {
                logger_1.logger.error('server.shutdown_failed', { message: err.message });
                process.exitCode = 1;
            }
            process.exit();
        });
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
}).catch(err => {
    logger_1.logger.error('server.start_failed', { message: err?.message });
    process.exit(1);
});
