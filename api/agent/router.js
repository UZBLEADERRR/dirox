const COMPLEXITIES = new Set(['low', 'medium', 'high']);

/** Select a model without ever exposing an API key to callers. */
export function classifyComplexity(input = {}) {
  const explicit = String(input.complexity || input.task?.complexity || '').toLowerCase();
  if (COMPLEXITIES.has(explicit)) return explicit;
  const text = `${input.title || input.task?.title || ''} ${input.description || input.task?.description || ''}`.toLowerCase();
  if (text.length > 2500 || /architecture|migration|security|refactor|multi[- ]file|production/.test(text)) return 'high';
  if (text.length > 500 || /api|database|integration|test|bug|feature/.test(text)) return 'medium';
  return 'low';
}

export function routeModel(input = {}, env = process.env) {
  const complexity = classifyComplexity(input);
  const configured = input.model || env[`OPENROUTER_MODEL_${complexity.toUpperCase()}`] || env.OPENROUTER_MODEL;
  return { complexity, model: configured || 'openai/gpt-4o-mini' };
}

export { COMPLEXITIES };
export default routeModel;
