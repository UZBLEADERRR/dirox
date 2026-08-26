/**
 * Preview server management.
 *
 * Starts a project's dev server inside the sandbox and keeps a handle to it, so
 * the agent can look at the running application rather than reasoning about
 * what the code probably renders.
 *
 * Servers are per-project, bounded in number, and reaped when idle — a
 * forgotten dev server is a memory leak and a security surface.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { config } from '../config/env.js';
import { badRequest, conflict, forbidden, notFound, timedOut } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { ensureWorkspace } from './workspace.js';
import { evaluateCommand } from './policy.js';
import { sandboxEnv } from './sandbox.js';

const MAX_SERVERS = 4;
const IDLE_TIMEOUT_MS = 15 * 60_000;
const START_TIMEOUT_MS = 90_000;
const PORT_RANGE = [_start(), _start() + 200];

function _start() { return Number(process.env.PREVIEW_PORT_BASE) || 43000; }

/** projectId -> { child, port, url, log, startedAt, lastUsedAt, status } */
const servers = new Map();

async function freePort() {
  for (let port = PORT_RANGE[0]; port < PORT_RANGE[1]; port += 1) {
    if ([...servers.values()].some(server => server.port === port)) continue;
    const available = await new Promise(resolve => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw conflict('No preview port is available. Stop another preview and try again.');
}

/** Dev servers print the URL they bound to; that is the signal they are ready. */
const READY_PATTERNS = [
  /(?:Local|local|ready|Ready|listening|Listening|started server|running at|Server running)[^\n]*?(https?:\/\/[^\s,]+)/,
  /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+)/
];

export function previewFor(projectId) {
  const server = servers.get(projectId);
  if (!server) return null;
  server.lastUsedAt = Date.now();
  return server;
}

export function previewStatus(projectId) {
  const server = servers.get(projectId);
  if (!server) return { running: false };
  return {
    running: server.status === 'ready' || server.status === 'starting',
    status: server.status,
    port: server.port,
    url: server.url,
    startedAt: server.startedAt,
    log: server.log.slice(-4000)
  };
}

/**
 * Start the project's dev server.
 * @returns {Promise<{url:string, port:number, status:string, log:string}>}
 */
export async function startPreview(projectId, { command, timeoutMs = START_TIMEOUT_MS } = {}) {
  if (!config.sandbox.enabled) throw forbidden('Command execution is disabled on this deployment');

  const existing = servers.get(projectId);
  if (existing && existing.status !== 'stopped') {
    existing.lastUsedAt = Date.now();
    return { url: existing.url, port: existing.port, status: existing.status, log: existing.log.slice(-2000) };
  }

  if (servers.size >= MAX_SERVERS) {
    // Evict the least recently used rather than refusing outright.
    const oldest = [...servers.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (oldest) await stopPreview(oldest[0]);
  }

  if (!command) throw badRequest('This project has no dev command configured. Set one in project settings.');

  const evaluation = await evaluateCommand(command);
  if (!evaluation.ok) throw forbidden(evaluation.reason);

  const workspace = await ensureWorkspace(projectId);
  const port = await freePort();

  const child = spawn(evaluation.executable, evaluation.args, {
    cwd: workspace,
    // PORT and HOST are how every framework is told where to bind.
    env: sandboxEnv(workspace, { PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' }),
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const server = {
    child, port, url: `http://127.0.0.1:${port}`, log: '',
    status: 'starting', startedAt: Date.now(), lastUsedAt: Date.now(), command
  };
  servers.set(projectId, server);

  const append = chunk => {
    server.log = (server.log + chunk).slice(-20_000);
    if (server.status !== 'starting') return;
    for (const pattern of READY_PATTERNS) {
      const match = pattern.exec(chunk);
      if (match) {
        // Trust the port we assigned, not the host the framework prints.
        server.status = 'ready';
        server.url = `http://127.0.0.1:${port}`;
        break;
      }
    }
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  child.on('exit', code => {
    server.status = 'stopped';
    server.exitCode = code;
    logger.info('preview server exited', { projectId, code });
  });

  // Wait for readiness, either from the log or from the port answering.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.status === 'stopped') {
      servers.delete(projectId);
      throw badRequest(`The dev server exited immediately (code ${server.exitCode}).\n${server.log.slice(-1500)}`);
    }
    if (server.status === 'ready' || await responds(port)) {
      server.status = 'ready';
      logger.info('preview server ready', { projectId, port, ms: Date.now() - server.startedAt });
      scheduleReaper();
      return { url: server.url, port, status: 'ready', log: server.log.slice(-2000) };
    }
    await new Promise(done => setTimeout(done, 500));
  }

  await stopPreview(projectId);
  throw timedOut(`The dev server did not become reachable within ${Math.round(timeoutMs / 1000)}s.\n${server.log.slice(-1500)}`);
}

/** Any HTTP answer means the server is up; the status code does not matter. */
async function responds(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

export async function stopPreview(projectId) {
  const server = servers.get(projectId);
  if (!server) return false;
  servers.delete(projectId);

  try {
    process.kill(-server.child.pid, 'SIGTERM');
    setTimeout(() => { try { process.kill(-server.child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref?.();
  } catch { /* already exited */ }

  logger.info('preview server stopped', { projectId });
  return true;
}

/** Fetch a page from a running preview, for the agent to inspect. */
export async function fetchPreview(projectId, path = '/') {
  const server = previewFor(projectId);
  if (!server || server.status !== 'ready') throw notFound('No preview server is running for this project');

  const safePath = String(path || '/').startsWith('/') ? path : `/${path}`;
  const response = await fetch(`${server.url}${safePath}`, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow'
  }).catch(error => { throw badRequest(`The preview did not respond: ${error.message}`); });

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('text/') || contentType.includes('json')
    ? (await response.text()).slice(0, 200_000)
    : `[${contentType || 'binary'}, ${response.headers.get('content-length') || 'unknown'} bytes]`;

  return { status: response.status, contentType, body, url: `${server.url}${safePath}` };
}

let reaper = null;
function scheduleReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [projectId, server] of servers) {
      if (now - server.lastUsedAt > IDLE_TIMEOUT_MS) {
        logger.info('reaping idle preview server', { projectId });
        stopPreview(projectId).catch(() => {});
      }
    }
    if (!servers.size) { clearInterval(reaper); reaper = null; }
  }, 60_000);
  reaper.unref?.();
}

export async function stopAllPreviews() {
  await Promise.allSettled([...servers.keys()].map(stopPreview));
}

export { servers, MAX_SERVERS, IDLE_TIMEOUT_MS };
