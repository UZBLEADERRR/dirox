/**
 * One OpenAI-shaped client. OpenRouter is the default because it is the only
 * one URL that reaches hundreds of models, but any base URL that speaks
 * /chat/completions works — Groq, Together, a local llama.cpp, anything.
 *
 * Streaming is parsed by hand rather than pulled from a library: the whole
 * point of this app is that it ships as static files with nothing to build.
 */

const enc = new TextDecoder();

function headers(s) {
  const h = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${s.apiKey}`,
  };
  if (/openrouter/i.test(s.baseUrl)) {
    h['HTTP-Referer'] = location.origin;
    h['X-Title'] = 'Mini';
  }
  return h;
}

export class LLMError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function fail(res) {
  let detail = '';
  try {
    const body = await res.text();
    try { detail = JSON.parse(body)?.error?.message || body; } catch { detail = body; }
  } catch {}
  const hint = res.status === 401 ? 'API kalit noto\'g\'ri.'
             : res.status === 402 ? 'Balans yetarli emas.'
             : res.status === 429 ? 'Juda ko\'p so\'rov. Biroz kuting.'
             : '';
  throw new LLMError([hint, detail].filter(Boolean).join(' ').slice(0, 400) || `HTTP ${res.status}`, res.status);
}

/**
 * Streams one completion.
 * Yields {t:'text',v} | {t:'reason',v} | {t:'tools',v:[…]} | {t:'usage',v}
 */
export async function* stream({ settings, messages, tools, signal, temperature }) {
  const body = {
    model: settings.model,
    messages,
    stream: true,
    temperature: temperature ?? settings.temperature ?? 0.7,
  };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  if (/openrouter/i.test(settings.baseUrl)) body.usage = { include: true };

  const res = await fetch(settings.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', headers: headers(settings), body: JSON.stringify(body), signal,
  });
  if (!res.ok) await fail(res);

  const reader = res.body.getReader();
  const calls = [];                    // accumulated tool calls, by index
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += enc.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;

      let json; try { json = JSON.parse(data); } catch { continue; }
      if (json.error) throw new LLMError(json.error.message || 'stream error');

      const d = json.choices?.[0]?.delta;
      if (d?.content) yield { t:'text', v:d.content };
      if (d?.reasoning) yield { t:'reason', v:d.reasoning };

      for (const tc of d?.tool_calls || []) {
        const i = tc.index ?? 0;
        calls[i] ||= { id:'', type:'function', function:{ name:'', arguments:'' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
      if (json.usage) yield { t:'usage', v:json.usage };
    }
  }
  if (calls.length) yield { t:'tools', v:calls.filter(Boolean) };
}

/** Model catalogue. OpenRouter and most gateways expose GET /models. */
export async function listModels(settings) {
  const res = await fetch(settings.baseUrl.replace(/\/+$/, '') + '/models', {
    headers: headers(settings),
  });
  if (!res.ok) await fail(res);
  const json = await res.json();
  const rows = json.data || json.models || [];
  return rows.map(m => ({
    id: m.id || m.name,
    name: m.name || m.id,
    ctx: m.context_length || m.context_window || 0,
    vision: !!(m.architecture?.input_modalities?.includes('image')
            || /vision|vl|gpt-4o|gemini|claude|llama-3\.2/i.test(m.id || '')),
    priceIn:  Number(m.pricing?.prompt || 0) * 1e6,
    priceOut: Number(m.pricing?.completion || 0) * 1e6,
    free: /:free$/.test(m.id || '') || Number(m.pricing?.prompt || 0) === 0,
  })).filter(m => m.id).sort((a,b) => a.id.localeCompare(b.id));
}
