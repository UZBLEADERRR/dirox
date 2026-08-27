/**
 * Anthropic Messages API adapter.
 *
 * Differs from the OpenAI shape in three ways that matter here: the system
 * prompt is a top-level field, tool results are user-role content blocks, and
 * prompt caching is opt-in per content block via `cache_control`.
 */

import { toJsonSchema } from '../../core/validate.js';

export const adapter = 'anthropic';

export function headersFor(provider, apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
    ...(provider.default_headers || {})
  };
}

export function endpoint(provider) {
  return `${provider.base_url.replace(/\/$/, '')}/messages`;
}

export function buildRequest({ model, messages, tools, temperature, maxTokens, stream, reasoningEffort, stop, cacheSystem }) {
  const system = [];
  const conversation = [];
  let boundaryIndex = -1;

  for (const message of messages) {
    if (message.role === 'system') {
      system.push({ type: 'text', text: String(message.content || '') });
      // The caller marks the end of the stable prefix. System blocks after it
      // are volatile and must stay outside the cached region.
      if (message.cacheBoundary) boundaryIndex = system.length - 1;
      continue;
    }
    if (message.role === 'tool') {
      // A tool result is a user-role content block referencing the call id.
      conversation.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content ?? '') }]
      });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: String(message.content) });
      for (const call of message.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name ?? call.name,
          input: typeof call.function?.arguments === 'string'
            ? safeJson(call.function.arguments)
            : (call.function?.arguments ?? call.arguments ?? {})
        });
      }
      conversation.push({ role: 'assistant', content: blocks });
      continue;
    }
    conversation.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content ?? ''),
      ...(message.cacheBoundary ? { cacheBoundary: true } : {})
    });
  }

  // Mark the end of the stable prefix cacheable. Tools and the system layer are
  // what repeat verbatim across the turns of a task, so that is where caching
  // pays off; a caller that marks no boundary gets the old behaviour.
  if (cacheSystem && model.supports_prompt_cache && system.length) {
    system[boundaryIndex >= 0 ? boundaryIndex : system.length - 1].cache_control = { type: 'ephemeral' };
  }

  /*
     A second breakpoint, inside the conversation.

     Tools and the system layer cache because they do not change. In an agent
     loop the history is the larger cost, and its older half does not change
     either — so the settled prefix is cached as well. The caller decides where
     that ends; it moves in strides, because writing a cache costs more than
     reading one.
  */
  if (cacheSystem && model.supports_prompt_cache) {
    for (const message of conversation) {
      if (!message.cacheBoundary) continue;
      const content = typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content;
      if (!content.length) continue;

      content[content.length - 1].cache_control = { type: 'ephemeral' };
      message.content = content;
      delete message.cacheBoundary;
    }
  }

  for (const message of conversation) delete message.cacheBoundary;

  const body = {
    model: model.code,
    max_tokens: maxTokens || model.max_output || 4096,
    messages: conversation.length ? conversation : [{ role: 'user', content: '' }],
    stream: Boolean(stream)
  };

  if (system.length) body.system = system;
  if (typeof temperature === 'number') body.temperature = temperature;
  if (stop?.length) body.stop_sequences = stop;

  if (tools?.length && model.supports_tools) {
    body.tools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: toJsonSchema(tool.schema)
    }));
  }

  if (reasoningEffort && reasoningEffort !== 'none' && model.supports_reasoning) {
    const budgets = { low: 2048, medium: 8192, high: 24576 };
    const budget = Math.min(budgets[reasoningEffort] ?? 4096, Math.max(1024, (body.max_tokens || 4096) - 512));
    body.thinking = { type: 'enabled', budget_tokens: budget };
    // Extended thinking requires the default temperature.
    delete body.temperature;
  }

  return body;
}

export function parseResponse(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
  const toolCalls = blocks
    .filter(block => block.type === 'tool_use')
    .map(block => ({ id: block.id, name: block.name, arguments: block.input || {} }));

  const usage = data?.usage ?? {};
  return {
    text,
    toolCalls,
    finishReason: mapStopReason(data?.stop_reason),
    usage: {
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
      reasoningTokens: 0
    },
    raw: { id: data?.id, model: data?.model }
  };
}

/** Anthropic streams named events; the caller passes the JSON payload here. */
export function parseStreamChunk(payload) {
  if (payload === '[DONE]') return { done: true };
  let data;
  try { data = JSON.parse(payload); } catch { return null; }

  switch (data.type) {
    case 'content_block_start':
      if (data.content_block?.type === 'tool_use') {
        return { toolCallDeltas: [{ index: data.index, id: data.content_block.id, name: data.content_block.name, argumentsChunk: '' }] };
      }
      return null;
    case 'content_block_delta':
      if (data.delta?.type === 'text_delta') return { text: data.delta.text };
      if (data.delta?.type === 'input_json_delta') {
        return { toolCallDeltas: [{ index: data.index, argumentsChunk: data.delta.partial_json || '' }] };
      }
      // Thinking deltas are never surfaced to the user; only their token count.
      return null;
    case 'message_delta':
      return {
        finishReason: data.delta?.stop_reason ? mapStopReason(data.delta.stop_reason) : undefined,
        usage: data.usage ? { outputTokens: data.usage.output_tokens ?? 0 } : undefined
      };
    case 'message_start':
      return data.message?.usage
        ? {
            usage: {
              inputTokens: (data.message.usage.input_tokens ?? 0) + (data.message.usage.cache_creation_input_tokens ?? 0),
              cachedInputTokens: data.message.usage.cache_read_input_tokens ?? 0,
              outputTokens: 0
            }
          }
        : null;
    case 'message_stop':
      return { done: true };
    case 'error':
      return { error: data.error?.message || 'Provider stream error' };
    default:
      return null;
  }
}

export function errorFrom(status, data) {
  return {
    message: data?.error?.message || `Provider returned ${status}`,
    code: data?.error?.type || null,
    retryable: status === 429 || status === 529 || status >= 500
  };
}

function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn': case 'stop_sequence': return 'stop';
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    default: return reason || 'stop';
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
