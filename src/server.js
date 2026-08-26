/**
 * DiroxCode server entry point.
 *
 * One process serves the API, the static client and the in-process job worker.
 * The architecture keeps these separable: `WORKER_ENABLED=false` turns the
 * worker off so it can be scaled out as its own Railway service later.
 */

import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config, configReport } from './config/env.js';
import { logger } from './core/logger.js';
import { drainObservability } from './modules/observability/audit.js';
import { startWorker, stopWorker } from './queue/worker.js';
// Importing the job modules is what registers their handlers with the worker.
import './modules/projects/service.js';
import './modules/agent/runner.js';

const app = createApp();
const server = createServer(app);

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 300_000;

server.listen(config.port, () => {
  const report = configReport();
  logger.info('DiroxCode listening', {
    port: config.port,
    env: config.env,
    capabilities: report.capabilities,
    degraded: report.warnings.length
  });
});

const workerEnabled = process.env.WORKER_ENABLED !== 'false';
if (workerEnabled) startWorker();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  const force = setTimeout(() => { logger.warn('forced exit'); process.exit(1); }, 15_000);
  force.unref();

  server.close();
  await stopWorker().catch(() => {});
  await drainObservability();
  clearTimeout(force);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', reason => logger.error('unhandled rejection', { reason: reason?.message || String(reason) }));
process.on('uncaughtException', error => {
  logger.error('uncaught exception', { message: error?.message, stack: error?.stack?.split('\n').slice(0, 5).join(' | ') });
  shutdown('uncaughtException');
});

export { server };
