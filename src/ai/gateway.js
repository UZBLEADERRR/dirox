/**
 * The AI Gateway.
 *
 * Every model request in DiroxCode goes through `complete()` or `stream()`.
 * That is what makes the following possible in one place rather than scattered:
 *
 *   - the browser never sees a provider key
 *   - usage and cost are recorded for every call, including failures
 *   - retries are bounded and never blindly repeat an expensive request
 *   - a failing model falls back to its configured alternate exactly once
 *   - deterministic calls can be served from a tenant-scoped cache
 */

import { createHash } from 'node:crypto';
import { adapterFor } from './providers/index.js';
import { loadCatalog, providerKey } from './catalog.js';
import { costOf, estimateMessageTokens } from './pricing.js';
import { route } from './router.js';
import { hasServiceRole, serviceClient } from '../db/supabase.js';
import { AppError, cancelled, notConfigured, timedOut, upstreamFailed } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { runtimeStats, metrics } from '../modules/observability/audit.js';
import { caches } from '../core/cache.js';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * @typedef {object} CompletionRequest
 * @property {Array<{role:string,content:any,tool_calls?:any,tool_call_id?:string,name?:string}>} messages
 * @property {object} [routing]      { category, level, allowedTiers, preferredModelId }
 * @property {object} [routeResult]  a pre-resolved route, to reuse across a loop
 * @property {Array}  [tools]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {'text'|'json'} [responseFormat]
 * @property {object} context        { orgId, userId, projectId, taskId }
 * @property {AbortSignal} [signal]
 * @property {boolean} [cache]       cache deterministic results within the tenant
 */

/** Non-streaming completion. */
export async function complete(request) {
  const resolved = request.routeResult ?? await route(request.routing ?? {});
  const cacheKey = request.cache ? deterministicKey(resolved.model, request) : null;

  if (cacheKey) {
    const hit = await readCache(request.context?.orgId, cacheKey);
    if (hit) {
      await recordUsage({ ...request.context, route: resolved, usage: hit.usage, costMicros: 0, latencyMs: 0, cacheHit: true });
      return { ...hit.response, cached: true, model: resolved.model, costMicros: 0 };
    }
  }

  const result = await callWithFallback(resolved, request, { stream: false });

  if (cacheKey && result.finishReason === 'stop' && !result.toolCalls.length) {
    writeCache(request.context?.orgId, cacheKey, resolved.model, result).catch(() => {});
  }

  return result;
}

/**
 * Streaming completion.
 * @param {CompletionRequest & {onDelta?:Function}} request
 */
export async function stream(request) {
  const resolved = request.routeResult ?? await route(request.routing ?? {});
  return callWithFallback(resolved, request, { stream: true });
}

// ─── execution ──────────────────────────────────────────────────────────────

async function callWithFallback(resolved, request, { stream }) {
  try {
    return await callWithRetry(resolved, request, { stream });
  } catch (error) {
    const app = error instanceof AppError ? error : upstreamFailed(String(error?.message || error));
    if (!resolved.fallback || app.status === 499 || app.code === 'cancelled' || !app.retryable) throw app;

    logger.warn('falling back to alternate model', {
      from: resolved.model.code, to: resolved.fallback.model.code, reason: app.message
    });

    const fallbackRoute = {
      ...resolved,
      model: resolved.fallback.model,
      provider: resolved.fallback.provider,
      fallback: null,     // one fallback hop only — never a cascade of retries
      maxOutputTokens: Math.min(resolved.maxOutputTokens, resolved.fallback.model.max_output)
    };

    const result = await callWithRetry(fallbackRoute, request, { stream });
    return { ...result, fallbackUsed: true, fallbackFrom: resolved.model.code };
  }
}

/**
 * Retry only what is worth retrying.
 *
 * A 429 or a 5xx is transient; a 400 means the request is wrong and repeating
 * it just spends money twice. Streaming calls are never retried once bytes have
 * reached the caller.
 */
async function callWithRetry(resolved, request, { stream }) {
  const maxAttempts = Math.max(1, Math.min(3, resolved.provider?.max_retries ?? 2));
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callProvider(resolved, request, { stream });
    } catch (error) {
      lastError = error;
      const app = error instanceof AppError ? error : upstreamFailed(String(error?.message || error));
      if (!app.retryable || attempt === maxAttempts || app.status === 499) throw app;
      if (stream && error.bytesDelivered) throw app;   // cannot restart a stream mid-flight

      const backoffMs = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.random() * 250;
      logger.debug('retrying model call', { model: resolved.model.code, attempt, backoffMs, reason: app.message });
      await new Promise(done => setTimeout(done, backoffMs));
    }
  }
  throw lastError;
}

async function callProvider(resolved, request, { stream }) {
  const { model, provider } = resolved;
  const adapter = adapterFor(provider);
  const apiKey = providerKey(provider);
  if (!apiKey) throw notConfigured(`API key for provider "${provider.code}" (expected in ${provider.key_ref || 'the database'})`);

  const messages = request.messages || [];
  const body = adapter.buildRequest({
    model,
    messages,
    tools: request.tools,
    temperature: request.temperature ?? resolved.temperature,
    maxTokens: Math.min(request.maxTokens || resolved.maxOutputTokens, model.max_output),
    stream,
    responseFormat: request.responseFormat,
    reasoningEffort: request.reasoningEffort ?? resolved.reasoningEffort,
    stop: request.stop,
    cacheSystem: request.cacheSystem !== false
  });

  let url = adapter.endpoint(provider, model, { stream });
  if (adapter.applyAuth) url = adapter.applyAuth(url, apiKey, { stream });

  const controller = new AbortController();
  const timeoutMs = request.timeoutMs || provider.timeout_ms || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const started = Date.now();
  const estimatedInput = estimateMessageTokens(messages);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: adapter.headersFor(provider, apiKey),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* the body may not be JSON */ }
      const mapped = adapter.errorFrom(response.status, data);

      runtimeStats.model(true);
      await recordUsage({
        ...request.context, route: resolved,
        usage: { inputTokens: estimatedInput, outputTokens: 0 },
        costMicros: 0, latencyMs: Date.now() - started,
        status: response.status === 429 ? 'error' : 'error', errorCode: mapped.code || String(response.status)
      });

      throw new AppError(`${provider.code}: ${mapped.message}`, {
        status: response.status === 401 || response.status === 403 ? 502 : response.status === 429 ? 429 : 502,
        code: response.status === 429 ? 'rate_limited' : 'upstream_failed',
        retryable: mapped.retryable
      });
    }

    const result = stream
      ? await consumeStream(response, adapter, request, { resolved, started, estimatedInput })
      : adapter.parseResponse(await response.json());

    if (!stream) {
      finaliseUsage(result, estimatedInput);
      const costMicros = costOf(model, result.usage);
      runtimeStats.model(false);
      await recordUsage({
        ...request.context, route: resolved, usage: result.usage,
        costMicros, latencyMs: Date.now() - started
      });
      return { ...result, model, provider: provider.code, costMicros, latencyMs: Date.now() - started, level: resolved.level, category: resolved.category };
    }

    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error?.name === 'AbortError') {
      if (request.signal?.aborted) throw cancelled('The model request was cancelled');
      throw timedOut(`${provider.code} did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    runtimeStats.model(true);
    throw upstreamFailed(`Could not reach ${provider.code}`, { reason: error?.message });
  } finally {
    clearTimeout(timer);
  }
}

/** Read an SSE stream, reassembling text and tool-call arguments. */
async function consumeStream(response, adapter, request, { resolved, started, estimatedInput }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = 'stop';
  let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  const toolCalls = new Map();
  let bytesDelivered = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;

          const chunk = adapter.parseStreamChunk(payload);
          if (!chunk || chunk.done) continue;
          if (chunk.error) throw upstreamFailed(chunk.error);

          if (chunk.text) {
            text += chunk.text;
            bytesDelivered += chunk.text.length;
            request.onDelta?.({ type: 'text', text: chunk.text });
          }

          for (const delta of chunk.toolCallDeltas || []) {
            const key = delta.index ?? delta.id ?? toolCalls.size;
            const existing = toolCalls.get(key) || { id: delta.id, name: delta.name, argumentsText: '' };
            if (delta.id) existing.id = delta.id;
            if (delta.name) existing.name = delta.name;
            existing.argumentsText += delta.argumentsChunk || '';
            toolCalls.set(key, existing);
            request.onDelta?.({ type: 'tool', name: existing.name });
          }

          if (chunk.finishReason) finishReason = chunk.finishReason;
          if (chunk.usage) usage = { ...usage, ...chunk.usage };
        }
      }
    }
  } catch (error) {
    error.bytesDelivered = bytesDelivered;
    throw error;
  }

  const result = {
    text,
    toolCalls: [...toolCalls.values()].map(call => ({
      id: call.id || `call_${call.name}`,
      name: call.name,
      arguments: safeJson(call.argumentsText)
    })),
    finishReason,
    usage
  };

  finaliseUsage(result, estimatedInput);
  const costMicros = costOf(resolved.model, result.usage);
  runtimeStats.model(false);

  await recordUsage({
    ...request.context, route: resolved, usage: result.usage,
    costMicros, latencyMs: Date.now() - started
  });

  return {
    ...result,
    model: resolved.model,
    provider: resolved.provider.code,
    costMicros,
    latencyMs: Date.now() - started,
    level: resolved.level,
    category: resolved.category
  };
}

/** Providers occasionally omit usage; estimate rather than record zero. */
function finaliseUsage(result, estimatedInput) {
  if (!result.usage.inputTokens) result.usage.inputTokens = estimatedInput;
  if (!result.usage.outputTokens && result.text) {
    result.usage.outputTokens = Math.ceil(result.text.length / 3.6);
    result.usage.estimated = true;
  }
}

// ─── usage ledger ───────────────────────────────────────────────────────────

/**
 * Record every call, successful or not.
 *
 * Written with the service role because a usage record must exist even for a
 * request whose user could not read it back, and must not be user-deletable.
 * Never throws into the caller.
 */
async function recordUsage({ orgId, userId, projectId, taskId, route: resolved, usage = {}, costMicros = 0, latencyMs = 0, cacheHit = false, status = 'ok', errorCode = null }) {
  if (!hasServiceRole()) return;
  try {
    const client = serviceClient();
    const record = {
      org_id: orgId ?? null,
      user_id: userId ?? null,
      project_id: projectId ?? null,
      task_id: taskId ?? null,
      model_id: resolved?.model?.id ?? null,
      provider_code: resolved?.provider?.code ?? null,
      model_code: resolved?.model?.code ?? null,
      category: resolved?.category ?? null,
      level: resolved?.level ?? null,
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      cached_input_tokens: usage.cachedInputTokens ?? 0,
      reasoning_tokens: usage.reasoningTokens ?? 0,
      cost_micros: costMicros,
      latency_ms: Math.round(latencyMs),
      cache_hit: cacheHit,
      fallback_used: Boolean(resolved?.escalatedFrom),
      escalated_from: resolved?.escalatedFrom ?? null,
      status,
      error_code: errorCode
    };

    await client.insert('usage_records', record, { returning: false });

    if (orgId) {
      await client.rpc('record_usage_daily', {
        p_day: new Date().toISOString().slice(0, 10),
        p_org: orgId,
        p_model: record.model_id,
        p_input: record.input_tokens,
        p_output: record.output_tokens,
        p_cached: record.cached_input_tokens,
        p_cost: costMicros,
        p_error: status !== 'ok'
      }).catch(() => {});
    }

    if (latencyMs > 10_000 || status !== 'ok') {
      metrics.observe({
        kind: 'model', name: record.model_code || 'unknown',
        status, durationMs: latencyMs, orgId,
        metadata: { level: record.level, category: record.category }
      });
    }
  } catch (error) {
    logger.warn('usage record not written', { reason: error?.message });
  }
}

// ─── response cache ─────────────────────────────────────────────────────────

/**
 * Cache key for a deterministic call.
 *
 * Only safe when temperature is 0 and no tools are involved: summarisation,
 * classification and titling. The organization id is part of the storage key,
 * never merely a filter, so a cached response cannot cross a tenant boundary.
 */
function deterministicKey(model, request) {
  const temperature = request.temperature ?? 0;
  if (temperature > 0 || request.tools?.length) return null;
  return createHash('sha256')
    .update(model.code)
    .update(JSON.stringify(request.messages))
    .update(String(request.maxTokens || ''))
    .digest('hex')
    .slice(0, 48);
}

async function readCache(orgId, cacheKey) {
  if (!orgId || !cacheKey) return null;

  const local = caches.completions.get(`${orgId}:${cacheKey}`);
  if (local) return local;

  if (!hasServiceRole()) return null;
  try {
    const row = await serviceClient().from('ai_cache')
      .select('response,input_tokens,output_tokens')
      .eq('org_id', orgId).eq('cache_key', cacheKey)
      .gt('expires_at', new Date().toISOString())
      .first();
    if (!row) return null;

    const hit = {
      response: row.response,
      usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens, cachedInputTokens: row.input_tokens, reasoningTokens: 0 }
    };
    caches.completions.set(`${orgId}:${cacheKey}`, hit);
    return hit;
  } catch {
    return null;
  }
}

async function writeCache(orgId, cacheKey, model, result) {
  if (!orgId || !cacheKey || !hasServiceRole()) return;
  const payload = { text: result.text, finishReason: result.finishReason, toolCalls: [] };
  caches.completions.set(`${orgId}:${cacheKey}`, { response: payload, usage: result.usage });
  await serviceClient().insert('ai_cache', {
    org_id: orgId, cache_key: cacheKey, model_code: model.code,
    category: result.category || 'chat', response: payload,
    input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens
  }, { upsert: true, onConflict: 'org_id,cache_key', returning: false }).catch(() => {});
}

function safeJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { __unparsed: String(text).slice(0, 2000) }; }
}

export { recordUsage, deterministicKey };
