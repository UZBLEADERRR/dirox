/**
 * OpenAI-compatible adapter.
 *
 * Serves OpenAI itself and every provider that speaks the same Chat Completions
 * shape: OpenRouter, DeepSeek, xAI, Moonshot, Together, local vLLM, and others.
 * Provider-specific behaviour is confined to `headersFor`.
 */

import { toJsonSchema } from '../../core/validate.js';

export const adapter = 'openai';

export function headersFor(provider, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(provider.default_headers || {})
  };
  // OpenRouter attributes traffic by these headers; harmless elsewhere.
  if (provider.adapter === 'openrouter') {
    headers['HTTP-Referer'] = provider.default_headers?.['HTTP-Referer'] || 'https://diroxcode.app';
    headers['X-Title'] = 'DiroxCode';
  }
  return headers;
}

export function endpoint(provider) {
  return `${provider.base_url.replace(/\/$/, '')}/chat/completions`;
}

/** Translate the neutral request shape into this provider's wire format. */
export function buildRequest({ model, messages, tools, temperature, maxTokens, stream, responseFormat, reasoningEffort, stop }) {
  const body = {
    model: model.code,
    messages: messages.map(normaliseMessage),
    stream: Boolean(stream)
  };

  if (typeof temperature === 'number') body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (stop?.length) body.stop = stop;
  if (stream) body.stream_options = { include_usage: true };

  if (tools?.length && model.supports_tools) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: toJsonSchema(tool.schema) }
    }));
    body.tool_choice = 'auto';
  }

  if (responseFormat === 'json' && model.supports_structured_output) {
    body.response_format = { type: 'json_object' };
  }

  if (reasoningEffort && reasoningEffort !== 'none' && model.supports_reasoning) {
    body.reasoning_effort = reasoningEffort;
  }

  return body;
}

function normaliseMessage(message) {
  const out = { role: message.role, content: message.content ?? '' };
  if (message.name) out.name = message.name;
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.tool_calls) out.tool_calls = message.tool_calls;
  return out;
}

/** Translate the provider's response into the neutral shape. */
export function parseResponse(data) {
  const choice = data?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const usage = data?.usage ?? {};

  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls: (message.tool_calls || []).map(call => ({
      id: call.id,
      name: call.function?.name,
      arguments: safeJson(call.function?.arguments)
    })),
    finishReason: choice.finish_reason || 'stop',
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0
    },
    raw: { id: data?.id, model: data?.model }
  };
}

/** Parse one SSE `data:` payload from a streaming response. */
export function parseStreamChunk(payload) {
  if (payload === '[DONE]') return { done: true };
  let data;
  try { data = JSON.parse(payload); } catch { return null; }

  const choice = data.choices?.[0];
  const delta = choice?.delta ?? {};
  const result = {};

  if (typeof delta.content === 'string' && delta.content) result.text = delta.content;
  if (delta.tool_calls) {
    result.toolCallDeltas = delta.tool_calls.map(call => ({
      index: call.index,
      id: call.id,
      name: call.function?.name,
      argumentsChunk: call.function?.arguments || ''
    }));
  }
  if (choice?.finish_reason) result.finishReason = choice.finish_reason;
  if (data.usage) {
    result.usage = {
      inputTokens: data.usage.prompt_tokens ?? 0,
      outputTokens: data.usage.completion_tokens ?? 0,
      cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens ?? 0
    };
  }
  return Object.keys(result).length ? result : null;
}

export function errorFrom(status, data) {
  return {
    message: data?.error?.message || data?.message || `Provider returned ${status}`,
    code: data?.error?.code || data?.error?.type || null,
    retryable: status === 408 || status === 409 || status === 429 || status >= 500
  };
}

function safeJson(text) {
  if (!text) return {};
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return { __unparsed: String(text).slice(0, 2000) }; }
}
