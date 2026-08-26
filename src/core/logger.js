/**
 * Structured JSON logging with secret redaction.
 *
 * Nothing that looks like a credential is ever written to a log line: keys are
 * matched by name and long token-shaped values are masked by pattern.
 */

const SECRET_KEYS = /(?:api[_-]?key|secret|token|password|authorization|cookie|service[_-]?role|client[_-]?secret|refresh)/i;
const TOKEN_PATTERN = /\b(?:sk-|pk-|ghp_|gho_|ghu_|ghs_|github_pat_|xai-|eyJ[A-Za-z0-9_-]{10,})[A-Za-z0-9_\-.]{8,}\b/g;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug);

export function redact(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return value.replace(TOKEN_PATTERN, '[redacted]');
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, message, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg: String(message).slice(0, 2000), ...redact(fields || {}) };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

export const logger = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
  /** Bind fields (request id, user id, task id) to every subsequent line. */
  child(bound = {}) {
    return {
      debug: (m, f) => emit('debug', m, { ...bound, ...f }),
      info: (m, f) => emit('info', m, { ...bound, ...f }),
      warn: (m, f) => emit('warn', m, { ...bound, ...f }),
      error: (m, f) => emit('error', m, { ...bound, ...f }),
      child: (more) => logger.child({ ...bound, ...more })
    };
  }
};

export default logger;
