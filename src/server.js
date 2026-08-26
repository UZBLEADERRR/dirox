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
import { stopAllPreviews } from './exec/preview.js';
import { startWorker, stopWorker } from './queue/worker.js';
import { migrate } from './db/migrate.js';
// Importing the job modules is what registers their handlers with the worker.
import './modules/projects/service.js';
import './modules/agent/runner.js';
import { startMaintenance } from './queue/maintenance.js';

/**
 * Apply pending migrations before serving.
 *
 * The server does not start until the schema it expects is present, so a
 * deploy can never serve traffic against a half-provisioned database. When
 * DATABASE_URL is absent this is skipped and the schema is the operator's
 * responsibility, which the boot report says plainly.
 */
async function applyMigrations() {
  if (!config.database.url || !config.database.migrateOnBoot) return null;

  const started = Date.now();
  try {
    const result = await migrate(config.database.url, {
      onProgress: ({ filename, state, durationMs }) => {
        if (state === 'applied') logger.info('migration applied', { filename, durationMs });
      }
    });

    if (result.applied.length) {
      logger.info('schema updated', { applied: result.applied.length, durationMs: result.durationMs });
    } else {
      logger.info('schema is up to date', { migrations: result.skipped.length, durationMs: Date.now() - started });
    }
    if (result.drifted.length) {
      logger.warn('migration files changed after being applied', { files: result.drifted });
    }
    return result;
  } catch (error) {
    // A schema that cannot be applied is not something to serve traffic on
    // top of: the failure is reported and the process exits so the platform
    // surfaces it as a failed deploy rather than a subtly broken one.
    logger.error('migrations failed — refusing to start', {
      message: error.message,
      pgCode: error.details?.pgCode,
      hint: error.details?.hint,
      filename: error.details?.filename
    });
    process.exit(1);
  }
}

await applyMigrations();

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
if (workerEnabled) {
  startWorker();
  startMaintenance();
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  const force = setTimeout(() => { logger.warn('forced exit'); process.exit(1); }, 15_000);
  force.unref();

  server.close();
  await stopWorker().catch(() => {});
  await stopAllPreviews().catch(() => {});
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
