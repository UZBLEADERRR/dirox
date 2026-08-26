/**
 * Admin control plane for the AI layer.
 *
 * Providers, models and routing rules are edited here and take effect on the
 * next request — no redeploy. Every mutation is audited, and API keys are
 * accepted but never returned.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, t, uuid } from '../../core/validate.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { serviceClient } from '../../db/supabase.js';
import { encryptSecret, maskSecret } from '../../core/crypto.js';
import { audit } from '../observability/audit.js';
import { invalidateCatalog, loadCatalog, providerKey } from '../../ai/catalog.js';
import { knownAdapters } from '../../ai/providers/index.js';
import { CATEGORIES, LEVELS } from '../../ai/router.js';
import { complete } from '../../ai/gateway.js';
import { costOf, estimateMessageTokens } from '../../ai/pricing.js';

/** Providers are returned with key status, never key material. */
function shapeProvider(provider) {
  const key = providerKey(provider);
  return {
    id: provider.id,
    code: provider.code,
    name: provider.name,
    adapter: provider.adapter,
    baseUrl: provider.base_url,
    keyRef: provider.key_ref,
    keyConfigured: Boolean(key),
    keyPreview: key ? maskSecret(key) : null,
    keySource: provider.key_ref && key ? 'environment' : provider.api_key_enc ? 'database' : null,
    enabled: provider.enabled,
    priority: provider.priority,
    timeoutMs: provider.timeout_ms,
    maxRetries: provider.max_retries,
    requestsPerMinute: provider.requests_per_minute,
    healthStatus: provider.health_status,
    healthCheckedAt: provider.health_checked_at
  };
}

function shapeModel(model, providers) {
  const provider = providers?.get(model.provider_id);
  return {
    id: model.id,
    providerId: model.provider_id,
    providerCode: provider?.code ?? null,
    code: model.code,
    name: model.name,
    description: model.description,
    inputPriceMicros: Number(model.input_price_micros),
    outputPriceMicros: Number(model.output_price_micros),
    cachedInputPriceMicros: model.cached_input_price_micros === null ? null : Number(model.cached_input_price_micros),
    contextWindow: model.context_window,
    maxOutput: model.max_output,
    supportsReasoning: model.supports_reasoning,
    supportsVision: model.supports_vision,
    supportsTools: model.supports_tools,
    supportsStructuredOutput: model.supports_structured_output,
    supportsPromptCache: model.supports_prompt_cache,
    tiers: model.tiers,
    enabled: model.enabled,
    priority: model.priority,
    fallbackModelId: model.fallback_model_id,
    requestsPerMinute: model.requests_per_minute,
    tokensPerMinute: model.tokens_per_minute
  };
}

const providerSchema = t.object({
  code: t.string({ max: 40, pattern: /^[a-z0-9_-]+$/, patternMessage: 'may contain lowercase letters, numbers, dash and underscore' }),
  name: t.string({ max: 80 }),
  adapter: t.enum(knownAdapters()),
  baseUrl: t.string({ max: 300 }),
  keyRef: t.string({ max: 60, pattern: /^[A-Z0-9_]*$/, patternMessage: 'must be an environment variable name in SCREAMING_SNAKE_CASE' }),
  apiKey: t.string({ max: 400, trim: false }),
  enabled: t.boolean(),
  priority: t.integer({ min: 0, max: 1000 }),
  timeoutMs: t.integer({ min: 5_000, max: 600_000 }),
  maxRetries: t.integer({ min: 0, max: 3 }),
  requestsPerMinute: t.integer({ min: 1, max: 100_000 })
});

const modelSchema = t.object({
  providerId: uuid(),
  code: t.string({ max: 140 }),
  name: t.string({ max: 80 }),
  description: t.string({ max: 400, truncate: true }),
  inputPriceMicros: t.integer({ min: 0, max: 1_000_000_000 }),
  outputPriceMicros: t.integer({ min: 0, max: 1_000_000_000 }),
  cachedInputPriceMicros: t.integer({ min: 0, max: 1_000_000_000 }),
  contextWindow: t.integer({ min: 1000, max: 20_000_000 }),
  maxOutput: t.integer({ min: 64, max: 500_000 }),
  supportsReasoning: t.boolean(),
  supportsVision: t.boolean(),
  supportsTools: t.boolean(),
  supportsStructuredOutput: t.boolean(),
  supportsPromptCache: t.boolean(),
  tiers: t.array(t.enum(LEVELS), { max: 5 }),
  enabled: t.boolean(),
  priority: t.integer({ min: 0, max: 1000 }),
  fallbackModelId: uuid(),
  requestsPerMinute: t.integer({ min: 1, max: 100_000 }),
  tokensPerMinute: t.integer({ min: 1000, max: 100_000_000 })
});

const MODEL_COLUMNS = {
  providerId: 'provider_id', code: 'code', name: 'name', description: 'description',
  inputPriceMicros: 'input_price_micros', outputPriceMicros: 'output_price_micros',
  cachedInputPriceMicros: 'cached_input_price_micros', contextWindow: 'context_window',
  maxOutput: 'max_output', supportsReasoning: 'supports_reasoning', supportsVision: 'supports_vision',
  supportsTools: 'supports_tools', supportsStructuredOutput: 'supports_structured_output',
  supportsPromptCache: 'supports_prompt_cache', tiers: 'tiers', enabled: 'enabled',
  priority: 'priority', fallbackModelId: 'fallback_model_id',
  requestsPerMinute: 'requests_per_minute', tokensPerMinute: 'tokens_per_minute'
};

function toColumns(body, map) {
  const patch = {};
  for (const [key, column] of Object.entries(map)) if (body[key] !== undefined) patch[column] = body[key];
  return patch;
}

export function adminModelRoutes() {
  const router = new Router();

  // ─── providers ────────────────────────────────────────────────────────────

  router.get('/providers', async ctx => {
    const rows = await serviceClient().from('model_providers').select('*').order('priority', { ascending: true }).limit(100).all();
    return sendJson(ctx.res, 200, { providers: rows.map(shapeProvider), adapters: knownAdapters() });
  }, { auth: 'platformAdmin' });

  router.post('/providers', async ctx => {
    const body = parse(providerSchema, await ctx.json());
    if (!body.code || !body.name || !body.baseUrl || !body.adapter) {
      throw badRequest('code, name, adapter and baseUrl are required');
    }
    if (!/^https:\/\//.test(body.baseUrl)) throw badRequest('baseUrl must use https');

    const row = await serviceClient().insert('model_providers', {
      code: body.code, name: body.name, adapter: body.adapter, base_url: body.baseUrl,
      key_ref: body.keyRef || null,
      api_key_enc: body.apiKey ? encryptSecret(body.apiKey) : null,
      enabled: body.enabled ?? true,
      priority: body.priority ?? 100,
      timeout_ms: body.timeoutMs ?? 120_000,
      max_retries: body.maxRetries ?? 2,
      requests_per_minute: body.requestsPerMinute ?? 300
    });

    invalidateCatalog();
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.provider_created', resource: 'provider', resourceId: row.id, severity: 'warning', metadata: { code: body.code } });
    return sendJson(ctx.res, 201, { provider: shapeProvider(row) });
  }, { auth: 'platformAdmin' });

  router.patch('/providers/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const body = parse(providerSchema, await ctx.json());

    const patch = toColumns(body, {
      code: 'code', name: 'name', adapter: 'adapter', baseUrl: 'base_url', enabled: 'enabled',
      priority: 'priority', timeoutMs: 'timeout_ms', maxRetries: 'max_retries', requestsPerMinute: 'requests_per_minute'
    });
    if (body.keyRef !== undefined) patch.key_ref = body.keyRef || null;
    if (body.apiKey) patch.api_key_enc = encryptSecret(body.apiKey);
    if (body.apiKey === '') patch.api_key_enc = null;
    if (patch.base_url && !/^https:\/\//.test(patch.base_url)) throw badRequest('baseUrl must use https');
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const [row] = await serviceClient().from('model_providers').eq('id', id).update(patch);
    if (!row) throw notFound('Provider not found');

    invalidateCatalog();
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.provider_updated', resourceId: id, severity: 'warning', metadata: { fields: Object.keys(patch) } });
    return sendJson(ctx.res, 200, { provider: shapeProvider(row) });
  }, { auth: 'platformAdmin' });

  router.delete('/providers/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const models = await serviceClient().from('models').select('id').eq('provider_id', id).limit(1).all();
    if (models.length) throw conflict('Remove or reassign this provider\'s models before deleting it');

    await serviceClient().from('model_providers').eq('id', id).remove();
    invalidateCatalog();
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.provider_deleted', resourceId: id, severity: 'critical' });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: 'platformAdmin' });

  // ─── models ───────────────────────────────────────────────────────────────

  router.get('/models', async ctx => {
    const client = serviceClient();
    const [models, providers] = await Promise.all([
      client.from('models').select('*').order('priority', { ascending: true }).limit(500).all(),
      client.from('model_providers').select('*').limit(100).all()
    ]);
    const providerMap = new Map(providers.map(p => [p.id, p]));
    return sendJson(ctx.res, 200, {
      models: models.map(model => shapeModel(model, providerMap)),
      levels: LEVELS
    });
  }, { auth: 'platformAdmin' });

  router.post('/models', async ctx => {
    const body = parse(modelSchema, await ctx.json());
    if (!body.providerId || !body.code || !body.name) throw badRequest('providerId, code and name are required');

    const row = await serviceClient().insert('models', {
      provider_id: body.providerId, code: body.code, name: body.name,
      description: body.description ?? '',
      input_price_micros: body.inputPriceMicros ?? 0,
      output_price_micros: body.outputPriceMicros ?? 0,
      cached_input_price_micros: body.cachedInputPriceMicros ?? null,
      context_window: body.contextWindow ?? 128_000,
      max_output: body.maxOutput ?? 8192,
      supports_reasoning: body.supportsReasoning ?? false,
      supports_vision: body.supportsVision ?? false,
      supports_tools: body.supportsTools ?? true,
      supports_structured_output: body.supportsStructuredOutput ?? true,
      supports_prompt_cache: body.supportsPromptCache ?? false,
      tiers: body.tiers?.length ? body.tiers : ['level1', 'level2'],
      enabled: body.enabled ?? true,
      priority: body.priority ?? 100,
      fallback_model_id: body.fallbackModelId ?? null,
      requests_per_minute: body.requestsPerMinute ?? 120,
      tokens_per_minute: body.tokensPerMinute ?? 200_000
    });

    invalidateCatalog();
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.model_created', resourceId: row.id, severity: 'warning', metadata: { code: body.code } });
    return sendJson(ctx.res, 201, { model: shapeModel(row) });
  }, { auth: 'platformAdmin' });

  router.patch('/models/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const body = parse(modelSchema, await ctx.json());
    const patch = toColumns(body, MODEL_COLUMNS);
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    // A model cannot fall back to itself, directly or in a one-hop cycle.
    if (patch.fallback_model_id === id) throw badRequest('A model cannot be its own fallback');

    const [row] = await serviceClient().from('models').eq('id', id).update(patch);
    if (!row) throw notFound('Model not found');

    invalidateCatalog();
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.model_updated', resourceId: id, severity: 'warning', metadata: { fields: Object.keys(patch) } });
    return sendJson(ctx.res, 200, { model: shapeModel(row) });
  }, { auth: 'platformAdmin' });

  router.delete('/models/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    await serviceClient().from('models').eq('id', id).remove();
    invalidateCatalog();
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.model_deleted', resourceId: id, severity: 'critical' });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: 'platformAdmin' });

  // ─── routing ──────────────────────────────────────────────────────────────

  router.get('/routes', async ctx => {
    const client = serviceClient();
    const [routes, models] = await Promise.all([
      client.from('model_routes').select('*').limit(200).all(),
      client.from('models').select('id,code,name,enabled').limit(500).all()
    ]);
    const modelMap = new Map(models.map(m => [m.id, m]));

    return sendJson(ctx.res, 200, {
      routes: routes.map(route => ({
        id: route.id,
        category: route.category,
        level: route.level,
        modelId: route.model_id,
        modelName: modelMap.get(route.model_id)?.name ?? null,
        fallbackModelId: route.fallback_model_id,
        fallbackModelName: route.fallback_model_id ? modelMap.get(route.fallback_model_id)?.name ?? null : null,
        maxInputTokens: route.max_input_tokens,
        maxOutputTokens: route.max_output_tokens,
        temperature: route.temperature,
        reasoningEffort: route.reasoning_effort,
        enabled: route.enabled,
        notes: route.notes
      })),
      categories: CATEGORIES,
      levels: LEVELS,
      models: models.filter(m => m.enabled).map(m => ({ id: m.id, code: m.code, name: m.name }))
    });
  }, { auth: 'platformAdmin' });

  /** Upsert a rule for a (category, level) pair. */
  router.put('/routes', async ctx => {
    const body = parse(t.object({
      category: t.enum(CATEGORIES, { required: true }),
      level: t.enum(LEVELS, { required: true }),
      modelId: uuid({ required: true }),
      fallbackModelId: uuid(),
      maxInputTokens: t.integer({ min: 500, max: 5_000_000 }),
      maxOutputTokens: t.integer({ min: 64, max: 500_000 }),
      temperature: t.number({ min: 0, max: 2 }),
      reasoningEffort: t.enum(['none', 'low', 'medium', 'high']),
      enabled: t.boolean({ default: true }),
      notes: t.string({ max: 300, truncate: true, default: '' })
    }), await ctx.json());

    if (body.fallbackModelId === body.modelId) throw badRequest('The fallback must be a different model');

    const row = await serviceClient().insert('model_routes', {
      category: body.category, level: body.level, model_id: body.modelId,
      fallback_model_id: body.fallbackModelId ?? null,
      max_input_tokens: body.maxInputTokens ?? null,
      max_output_tokens: body.maxOutputTokens ?? null,
      temperature: body.temperature ?? 0.2,
      reasoning_effort: body.reasoningEffort ?? null,
      enabled: body.enabled,
      notes: body.notes
    }, { upsert: true, onConflict: 'category,level' });

    invalidateCatalog();
    audit.record({
      actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.route_updated',
      resource: 'route', resourceId: `${body.category}:${body.level}`, severity: 'warning'
    });
    return sendJson(ctx.res, 200, { route: row });
  }, { auth: 'platformAdmin' });

  router.delete('/routes/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    await serviceClient().from('model_routes').eq('id', id).remove();
    invalidateCatalog();
    audit.record({ actorId: ctx.auth.user.id, actorType: 'admin', action: 'admin.route_deleted', resourceId: id, severity: 'warning' });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: 'platformAdmin' });

  /**
   * Model playground.
   *
   * Lets an administrator compare a model's answer, latency, tokens and cost
   * before enabling it for routing. The call is real — nothing is simulated.
   */
  router.post('/playground', async ctx => {
    const body = parse(t.object({
      modelId: uuid({ required: true }),
      system: t.string({ max: 8000, truncate: true, default: '' }),
      prompt: t.string({ required: true, max: 20_000, truncate: true }),
      temperature: t.number({ min: 0, max: 2, default: 0.2 }),
      maxTokens: t.integer({ min: 32, max: 32_000, default: 1024 }),
      reasoningEffort: t.enum(['none', 'low', 'medium', 'high'])
    }), await ctx.json());

    const catalog = await loadCatalog({ fresh: true });
    const model = catalog.modelsById.get(body.modelId);
    if (!model) throw notFound('Model not found or not enabled');
    const provider = catalog.providers.get(model.provider_id);

    const messages = [
      ...(body.system ? [{ role: 'system', content: body.system }] : []),
      { role: 'user', content: body.prompt }
    ];

    const started = Date.now();
    try {
      const result = await complete({
        messages,
        routeResult: {
          model, provider, fallback: null, category: 'chat', level: 'level0', source: 'playground',
          temperature: body.temperature, maxOutputTokens: body.maxTokens,
          maxInputTokens: model.context_window, reasoningEffort: body.reasoningEffort ?? null
        },
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        context: { orgId: ctx.auth.org?.id, userId: ctx.auth.user.id }
      });

      return sendJson(ctx.res, 200, {
        ok: true,
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
        costMicros: result.costMicros,
        latencyMs: result.latencyMs,
        estimatedInputTokens: estimateMessageTokens(messages),
        model: { id: model.id, code: model.code, name: model.name, provider: provider?.code }
      });
    } catch (error) {
      return sendJson(ctx.res, 200, {
        ok: false,
        error: { code: error.code || 'upstream_failed', message: error.message },
        latencyMs: Date.now() - started,
        model: { id: model.id, code: model.code, name: model.name, provider: provider?.code }
      });
    }
  }, { auth: 'platformAdmin', rateLimit: 'heavy' });

  /** Verify each provider actually answers with its configured key. */
  router.post('/providers/:id/health', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const catalog = await loadCatalog({ fresh: true });
    const provider = catalog.providers.get(id);
    if (!provider) throw notFound('Provider not found or disabled');

    const model = catalog.models.find(m => m.provider_id === id);
    if (!model) throw badRequest('This provider has no enabled model to test with');

    const started = Date.now();
    let status = 'healthy';
    let detail = null;

    try {
      const result = await complete({
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        routeResult: {
          model, provider, fallback: null, category: 'chat', level: 'level0', source: 'health',
          temperature: 0, maxOutputTokens: 16, maxInputTokens: 1000, reasoningEffort: null
        },
        maxTokens: 16,
        timeoutMs: 20_000,
        context: { orgId: ctx.auth.org?.id, userId: ctx.auth.user.id }
      });
      detail = { text: result.text.slice(0, 100), costMicros: result.costMicros };
    } catch (error) {
      status = error.status === 429 ? 'degraded' : 'down';
      detail = { error: error.message };
    }

    const latencyMs = Date.now() - started;
    await serviceClient().from('model_providers').eq('id', id).update({
      health_status: status, health_checked_at: new Date().toISOString()
    });
    invalidateCatalog();

    return sendJson(ctx.res, 200, { status, latencyMs, model: model.code, detail });
  }, { auth: 'platformAdmin', rateLimit: 'heavy' });

  return router;
}

export { shapeModel, shapeProvider };
