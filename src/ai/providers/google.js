/**
 * Google Generative Language adapter.
 *
 * The wire format is the most different of the three: `contents` with `parts`,
 * `model`/`user` roles rather than `assistant`/`user`, and the API key on the
 * query string rather than a header.
 */

import { toJsonSchema } from '../../core/validate.js';

export const adapter = 'google';

export function headersFor(provider) {
  return { 'Content-Type': 'application/json', ...(provider.default_headers || {}) };
}

export function endpoint(provider, model, { stream = false } = {}) {
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  return `${provider.base_url.replace(/\/$/, '')}/models/${model.code}:${method}`;
}

/** Google takes the key as a query parameter, not a header. */
export function applyAuth(url, apiKey, { stream = false } = {}) {
  const target = new URL(url);
  target.searchParams.set('key', apiKey);
  if (stream) target.searchParams.set('alt', 'sse');
  return target.toString();
}

export function buildRequest({ model, messages, tools, temperature, maxTokens, stop }) {
  const contents = [];
  const systemParts = [];

  for (const message of messages) {
    if (message.role === 'system') { systemParts.push({ text: String(message.content || '') }); continue; }

    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: message.name || 'tool', response: { result: String(message.content ?? '') } } }]
      });
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      contents.push({
        role: 'model',
        parts: message.tool_calls.map(call => ({
          functionCall: {
            name: call.function?.name ?? call.name,
            args: typeof call.function?.arguments === 'string' ? safeJson(call.function.arguments) : (call.function?.arguments ?? call.arguments ?? {})
          }
        }))
      });
      continue;
    }

    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message.content ?? '') }]
    });
  }

  const body = {
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '' }] }],
    generationConfig: {
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
      ...(stop?.length ? { stopSequences: stop } : {})
    }
  };

  if (systemParts.length) body.systemInstruction = { parts: systemParts };

  if (tools?.length && model.supports_tools) {
    body.tools = [{
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: toJsonSchema(tool.schema)
      }))
    }];
  }

  return body;
}

export function parseResponse(data) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const usage = data?.usageMetadata ?? {};

  return {
    text: parts.filter(part => part.text).map(part => part.text).join(''),
    toolCalls: parts
      .filter(part => part.functionCall)
      .map((part, index) => ({ id: `call_${index}`, name: part.functionCall.name, arguments: part.functionCall.args || {} })),
    finishReason: mapFinish(candidate?.finishReason),
    usage: {
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      cachedInputTokens: usage.cachedContentTokenCount ?? 0,
      reasoningTokens: usage.thoughtsTokenCount ?? 0
    },
    raw: { model: data?.modelVersion }
  };
}

export function parseStreamChunk(payload) {
  if (payload === '[DONE]') return { done: true };
  let data;
  try { data = JSON.parse(payload); } catch { return null; }

  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const result = {};

  const text = parts.filter(part => part.text).map(part => part.text).join('');
  if (text) result.text = text;

  const calls = parts.filter(part => part.functionCall);
  if (calls.length) {
    result.toolCallDeltas = calls.map((part, index) => ({
      index,
      id: `call_${index}`,
      name: part.functionCall.name,
      argumentsChunk: JSON.stringify(part.functionCall.args || {})
    }));
  }

  if (candidate?.finishReason) result.finishReason = mapFinish(candidate.finishReason);
  if (data.usageMetadata) {
    result.usage = {
      inputTokens: data.usageMetadata.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
      cachedInputTokens: data.usageMetadata.cachedContentTokenCount ?? 0,
      reasoningTokens: data.usageMetadata.thoughtsTokenCount ?? 0
    };
  }
  return Object.keys(result).length ? result : null;
}

export function errorFrom(status, data) {
  return {
    message: data?.error?.message || `Provider returned ${status}`,
    code: data?.error?.status || null,
    retryable: status === 429 || status >= 500
  };
}

function mapFinish(reason) {
  switch (reason) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY': case 'RECITATION': return 'content_filter';
    default: return reason ? String(reason).toLowerCase() : 'stop';
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
