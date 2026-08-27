/**
 * Central environment configuration.
 *
 * Every environment variable the platform reads is declared here exactly once,
 * so a missing or misconfigured variable surfaces as a clear boot-time report
 * instead of an obscure runtime failure deep inside a request.
 */

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};
const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

const env = process.env;

export const config = {
  env: env.NODE_ENV || 'development',
  isProduction: (env.NODE_ENV || 'development') === 'production',
  port: int(env.PORT, 3000),
  appUrl: (env.APP_URL || '').replace(/\/$/, ''),
  corsOrigins: list(env.CORS_ORIGINS),

  supabase: {
    url: (env.SUPABASE_URL || '').replace(/\/$/, ''),
    anonKey: env.SUPABASE_ANON_KEY || '',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || ''
  },

  /**
   * Direct Postgres connection, used only to apply migrations.
   *
   * Separate from the Supabase REST credentials on purpose: this is the one
   * place the application talks to the database over the wire protocol, and it
   * is not used to serve any request.
   */
  database: {
    url: env.DATABASE_URL || '',
    migrateOnBoot: bool(env.MIGRATE_ON_BOOT, true)
  },

  encryptionKey: env.DIROX_ENCRYPTION_KEY || '',

  /**
   * Accounts that hold platform administration.
   *
   * A list of email addresses rather than a seeded row, because the owner of a
   * fresh deployment has no way to insert one: the admin panel is the only
   * place to grant access and it is the thing being locked. Promotion happens
   * when the address signs in, and only for an address the identity provider
   * has confirmed — an unverified one would let anyone claim it by typing it.
   */
  platformAdminEmails: list(env.PLATFORM_ADMIN_EMAILS || 'sarvarbeksanjarivich@gmail.com')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean),

  github: {
    clientId: env.GITHUB_CLIENT_ID || '',
    clientSecret: env.GITHUB_CLIENT_SECRET || '',
    callback: env.GITHUB_OAUTH_CALLBACK || ''
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || ''
  },

  sandbox: {
    enabled: bool(env.SANDBOX_ENABLED, true),
    workspaceRoot: env.WORKSPACE_ROOT || '/tmp/diroxcode-workspaces',
    timeoutMs: int(env.SANDBOX_TIMEOUT_MS, 120_000),
    maxOutput: int(env.SANDBOX_MAX_OUTPUT, 20_000)
  },

  /** Provider secrets are read by reference (`key_ref`), never by hardcoded name. */
  providerKey(ref) {
    if (!ref || !/^[A-Z0-9_]+$/.test(ref)) return '';
    return env[ref] || '';
  }
};

/** Capabilities the platform can honestly offer with the current configuration. */
export function capabilities() {
  return {
    database: Boolean(config.supabase.url && config.supabase.anonKey),
    migrations: Boolean(config.database.url),
    systemWrites: Boolean(config.supabase.serviceKey),
    encryption: config.encryptionKey.length >= 16,
    github: Boolean(config.github.clientId && config.github.clientSecret),
    billing: Boolean(config.stripe.secretKey),
    sandbox: config.sandbox.enabled
  };
}

/** Non-fatal boot report: the server starts degraded rather than refusing to run. */
export function configReport() {
  const caps = capabilities();
  const warnings = [];
  if (!caps.database) warnings.push('SUPABASE_URL / SUPABASE_ANON_KEY missing — auth and persistence are disabled.');
  if (!caps.migrations) warnings.push('DATABASE_URL missing — the schema must be applied manually. Set it to have the server keep the schema current.');
  if (!caps.systemWrites) {
    warnings.push('SUPABASE_SERVICE_ROLE_KEY missing — admin and system writes are disabled.');
    // Worth saying separately, because the consequence is not a missing
    // feature but silent data loss: without durable storage a project that
    // was never pushed to GitHub exists only until the next deploy.
    warnings.push('Durable file storage is unavailable — work in a project with no GitHub remote will not survive a restart.');
  }
  if (!caps.encryption) warnings.push('DIROX_ENCRYPTION_KEY missing — provider keys cannot be stored encrypted.');
  if (!caps.github) warnings.push('GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing — GitHub integration is disabled.');
  if (!caps.billing) warnings.push('STRIPE_SECRET_KEY missing — billing runs in read-only plan mode.');
  if (config.isProduction && !config.corsOrigins.length) warnings.push('CORS_ORIGINS is empty in production — browser calls from other origins will be rejected.');
  return { capabilities: caps, warnings };
}

export default config;
