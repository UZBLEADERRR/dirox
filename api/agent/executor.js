const clip = (value, max) => String(value ?? '').trim().slice(0, max);

function extractContent(data) {
  return data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.output ?? data;
}

/** Execute one subtask through an injected OpenRouter callback (or global fetch). */
export async function executeSubtask(subtask = {}, context = {}, options = {}) {
  const model = options.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const prompt = `Implement this subtask: ${clip(subtask.title || subtask, 600)}\nRelevant context:\n${clip(context.relevant || context.context || context, 5000)}\nRespond with a concise result and mention checks run.`;
  const payload = { model, messages: [{ role: 'system', content: 'You are a precise coding executor. Do not invent evidence.' }, { role: 'user', content: prompt }], temperature: 0.1, max_tokens: options.maxTokens || 1200 };
  const callback = options.openRouterFetch || options.fetchOpenRouter;
  let data;
  if (typeof callback === 'function') data = await callback(payload);
  else {
    if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
    const response = await fetch(options.url || 'https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || 'OpenRouter request failed');
  }
  const result = extractContent(data);
  if (result === undefined || result === null || result === '') throw new Error('Executor returned an empty result');
  return { result: clip(typeof result === 'string' ? result : JSON.stringify(result), 10000), model };
}

export { extractContent };
export default executeSubtask;
