/**
 * The model catalogue.
 *
 * Providers, models and routing rules are database rows an administrator edits
 * at runtime; nothing here is hardcoded. Reads are cached briefly so the hot
 * path does not query on every call, and the cache is invalidated explicitly
 * whenever the admin changes something.
 */

import { serviceClient, hasServiceRole } from '../db/supabase.js';
import { caches } from '../core/cache.js';
import { config } from '../config/env.js';
import { decryptSecret } from '../core/crypto.js';
import { notConfigured } from '../core/errors.js';
import { logger } from '../core/logger.js';

const CACHE_TTL = 60_000;

/** @returns {Promise<{providers: Map<string,object>, models: object[], routes: object[]}>} */
export async function loadCatalog({ fresh = false } = {}) {
  if (fresh) caches.models.delete('catalog');

  return caches.models.wrap('catalog', async () => {
    if (!hasServiceRole()) throw notConfigured('AI catalogue (SUPABASE_SERVICE_ROLE_KEY)');
    const client = serviceClient();

    const [providers, models, routes] = await Promise.all([
      client.from('model_providers').select('*').eq('enabled', true).order('priority', { ascending: true }).limit(50).all(),
      client.from('models').select('*').eq('enabled', true).order('priority', { ascending: true }).limit(300).all(),
      client.from('model_routes').select('*').eq('enabled', true).limit(200).all()
    ]);

    const providerById = new Map(providers.map(provider => [provider.id, provider]));
    const usable = models.filter(model => providerById.has(model.provider_id));

    if (!usable.length) {
      logger.warn('no usable models in catalogue', { providers: providers.length, models: models.length });
    }

    return {
      providers: providerById,
      providersByCode: new Map(providers.map(p => [p.code, p])),
      models: usable,
      modelsById: new Map(usable.map(model => [model.id, model])),
      modelsByCode: new Map(usable.map(model => [model.code, model])),
      routes,
      loadedAt: Date.now()
    };
  }, CACHE_TTL);
}

export function invalidateCatalog() {
  caches.models.delete('catalog');
  caches.settings.delete('system:agent.defaults');
  caches.settings.delete('system:context.budget');
}

/**
 * Resolve a provider's API key.
 *
 * `key_ref` (an environment variable name) is preferred: the secret then lives
 * in Railway, not in the database. `api_key_enc` is the fallback for keys the
 * admin pasted into the dashboard.
 */
export function providerKey(provider) {
  if (provider.key_ref) {
    const value = config.providerKey(provider.key_ref);
    if (value) return value;
  }
  if (provider.api_key_enc) {
    try { return decryptSecret(provider.api_key_enc); }
    catch (error) { logger.error('provider key could not be decrypted', { provider: provider.code, reason: error?.message }); }
  }
  return '';
}

/** Providers that actually have a usable key right now. */
export async function availableProviders() {
  const catalog = await loadCatalog();
  return [...catalog.providers.values()].filter(provider => Boolean(providerKey(provider)));
}

/** System settings, cached. Editable by the admin without a redeploy. */
export async function systemSetting(key, fallback = {}) {
  return caches.settings.wrap(`system:${key}`, async () => {
    if (!hasServiceRole()) return fallback;
    const row = await serviceClient().from('system_settings').select('value').eq('key', key).first();
    return row?.value ?? fallback;
  }, 30_000);
}

/** Feature flags with percentage rollout resolved for one organization. */
export async function featureEnabled(key, orgId, planCode) {
  const flags = await caches.settings.wrap('system:flags', async () => {
    if (!hasServiceRole()) return [];
    return serviceClient().from('feature_flags').select('*').limit(100).all();
  }, 30_000);

  const flag = flags.find(item => item.key === key);
  if (!flag) return false;
  if (Array.isArray(flag.disabled_orgs) && flag.disabled_orgs.includes(orgId)) return false;
  if (Array.isArray(flag.enabled_orgs) && flag.enabled_orgs.includes(orgId)) return true;
  if (!flag.enabled) return false;
  if (flag.required_plan_codes?.length && planCode && !flag.required_plan_codes.includes(planCode)) return false;
  if (flag.rollout_percentage >= 100) return true;
  if (flag.rollout_percentage <= 0) return false;

  // Stable bucketing: the same organization always lands in the same bucket.
  let hash = 0;
  for (const char of String(orgId || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % 100) < flag.rollout_percentage;
}

export async function allFeatureFlags(orgId, planCode) {
  const flags = await caches.settings.wrap('system:flags', async () => {
    if (!hasServiceRole()) return [];
    return serviceClient().from('feature_flags').select('*').limit(100).all();
  }, 30_000);

  const resolved = {};
  for (const flag of flags) resolved[flag.key] = await featureEnabled(flag.key, orgId, planCode);
  return resolved;
}

export { CACHE_TTL };
