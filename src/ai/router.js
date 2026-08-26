/**
 * Model routing.
 *
 * Two decisions, kept separate on purpose:
 *
 *   1. How hard is this task?  -> `classify()`, heuristics first, a cheap model
 *      only when the heuristics are genuinely uncertain.
 *   2. Which model serves that?  -> `route()`, a database lookup on
 *      (category, level) that an administrator can change without a redeploy.
 *
 * The strongest model is never the starting point. Escalation happens only
 * after a measured failure, and never more than the configured number of times.
 */

import { loadCatalog, systemSetting } from './catalog.js';
import { badRequest, notConfigured } from '../core/errors.js';
import { logger } from '../core/logger.js';

export const LEVELS = ['level0', 'level1', 'level2', 'level3', 'level4'];
export const CATEGORIES = ['chat', 'classify', 'plan', 'code', 'debug', 'review', 'architecture', 'summarize', 'embed', 'title'];

const levelIndex = level => Math.max(0, LEVELS.indexOf(level));

/**
 * Heuristic complexity classification.
 *
 * These patterns cost nothing and settle the large majority of requests. The
 * result carries a confidence so the caller can decide whether a model-based
 * second opinion is worth its own tokens.
 *
 * @returns {{level:string, category:string, confidence:number, reasons:string[]}}
 */
export function classify({ text = '', mode = 'agent', fileCount = 0, hasError = false, hasAttachment = false, conversationTurns = 0 } = {}) {
  const source = String(text).toLowerCase().trim();
  const words = source.split(/\s+/).filter(Boolean).length;
  const reasons = [];

  // ── category ──
  let category = 'chat';
  if (mode === 'review') category = 'review';
  else if (mode === 'debug') category = 'debug';
  else if (mode === 'plan') category = 'plan';
  else if (/\b(architect|architecture|design the system|restructure|migrate the|rewrite the|scalab)/.test(source)) category = 'architecture';
  else if (hasError || /\b(error|exception|stack ?trace|traceback|crash|fails?|failing|500|404|bug|broken|not working|undefined is not)/.test(source)) category = 'debug';
  else if (/\b(review|audit|security|vulnerab|code smell|best practice)/.test(source)) category = 'review';
  else if (/\b(add|build|implement|create|fix|refactor|write|update|change|remove|delete|rename|migrate|install|integrate)\b/.test(source)) category = 'code';
  else if (/\b(explain|what|why|how|where|which|does|describe|show me|tell me)\b/.test(source)) category = 'chat';

  // ── level ──
  let level = 'level1';

  const trivial = /^(hi|hey|hello|yo|thanks|thank you|ok|okay|got it|nice|cool|sure|yes|no|ping|test)\b/.test(source);
  if (trivial || words <= 3) {
    reasons.push('greeting or trivial input');
    return { level: 'level0', category: category === 'code' ? 'code' : 'chat', confidence: 0.95, reasons };
  }

  if (mode === 'ask' && words < 40 && !hasError) { level = 'level1'; reasons.push('short question in ask mode'); }

  const strong = /\b(architect|architecture|redesign|distributed|scalability|concurren|race condition|deadlock|memory leak|performance bottleneck|security (audit|review|vulnerab)|migration strategy|multi-tenan|refactor the entire|across the (whole|entire) (codebase|project))\b/;
  const moderate = /\b(refactor|multiple files|across files|integrate|authentication|authorization|payment|stripe|webhook|database|schema|migration|api|endpoint|test|deploy|optimi[sz]e|cach)\b/;

  if (strong.test(source)) { level = 'level3'; reasons.push('mentions architecture, concurrency or security analysis'); }
  else if (moderate.test(source)) { level = 'level2'; reasons.push('multi-file or integration work'); }

  if (words > 220) { level = LEVELS[Math.min(4, levelIndex(level) + 1)]; reasons.push('long, detailed request'); }
  if (fileCount > 12) { level = LEVELS[Math.min(4, levelIndex(level) + 1)]; reasons.push(`${fileCount} files in scope`); }
  if (hasAttachment) reasons.push('attachment supplied');
  if (conversationTurns > 12) reasons.push('long conversation');

  if (category === 'architecture' && levelIndex(level) < 3) { level = 'level3'; reasons.push('architecture category'); }
  if (mode === 'autopilot' && levelIndex(level) < 2) { level = 'level2'; reasons.push('autopilot mode'); }
  if (category === 'chat' && !hasError && words < 25 && levelIndex(level) < 1) level = 'level1';

  // Confidence is low when the request is mid-length and matched no strong
  // signal — exactly the case where a cheap classifier call earns its cost.
  const matchedSignal = strong.test(source) || moderate.test(source) || trivial || hasError;
  const confidence = matchedSignal ? 0.85 : words < 12 ? 0.8 : 0.55;

  return { level, category, confidence, reasons };
}

/** The prompt used when the heuristic is not confident enough. */
export function classifierPrompt(text) {
  return [
    {
      role: 'system',
      content: [
        'You classify software engineering requests for a routing system.',
        'Reply with JSON only: {"level":"level0|level1|level2|level3|level4","category":"chat|code|debug|review|architecture|plan"}',
        '',
        'level0 = greeting, trivial question, formatting',
        'level1 = single-file edit, simple lookup, documentation',
        'level2 = multi-file change, moderate debugging, tests',
        'level3 = architecture, complex refactor, hard debugging, security analysis',
        'level4 = exceptionally complex engineering work',
        '',
        'Choose the LOWEST level that can plausibly succeed. Do not explain.'
      ].join('\n')
    },
    { role: 'user', content: String(text).slice(0, 1500) }
  ];
}

export function parseClassification(text, fallback) {
  try {
    const match = String(text).match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    const level = LEVELS.includes(parsed.level) ? parsed.level : fallback.level;
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : fallback.category;
    return { level, category, confidence: 0.9, reasons: ['classified by model'] };
  } catch {
    return fallback;
  }
}

/**
 * Resolve (category, level) to a concrete model and its call parameters.
 *
 * Falls back down the level ladder, then to any enabled model that serves the
 * requested tier, so a missing routing row degrades instead of failing.
 *
 * @param {{category:string, level:string, allowedTiers?:string[], preferredModelId?:string, requireTools?:boolean, requireVision?:boolean}} request
 */
export async function route(request) {
  const catalog = await loadCatalog();
  if (!catalog.models.length) throw notConfigured('AI models (no enabled model in the catalogue)');

  const category = CATEGORIES.includes(request.category) ? request.category : 'chat';
  const requestedLevel = LEVELS.includes(request.level) ? request.level : 'level1';

  // A plan may cap which tiers an organization can reach.
  const allowed = request.allowedTiers?.length ? request.allowedTiers : LEVELS;
  let level = requestedLevel;
  while (!allowed.includes(level) && levelIndex(level) > 0) level = LEVELS[levelIndex(level) - 1];

  const capable = model =>
    (!request.requireTools || model.supports_tools) &&
    (!request.requireVision || model.supports_vision);

  // 1. An explicit user preference, if it is allowed and capable.
  if (request.preferredModelId) {
    const preferred = catalog.modelsById.get(request.preferredModelId);
    if (preferred && capable(preferred) && preferred.tiers?.some(tier => allowed.includes(tier))) {
      return buildRoute(catalog, preferred, null, { category, level, source: 'user_preference' });
    }
  }

  // 2. The configured routing rule, walking down levels if none exists.
  for (let index = levelIndex(level); index >= 0; index -= 1) {
    const candidateLevel = LEVELS[index];
    if (!allowed.includes(candidateLevel)) continue;
    const rule = catalog.routes.find(r => r.category === category && r.level === candidateLevel);
    if (!rule) continue;
    const model = catalog.modelsById.get(rule.model_id);
    if (!model || !capable(model)) continue;
    return buildRoute(catalog, model, rule, {
      category, level: candidateLevel, source: index === levelIndex(level) ? 'route' : 'route_downgraded'
    });
  }

  // 3. Any enabled model that serves an allowed tier, cheapest first.
  const fallback = catalog.models
    .filter(model => capable(model) && model.tiers?.some(tier => allowed.includes(tier)))
    .sort((a, b) => Number(a.input_price_micros) - Number(b.input_price_micros))[0];

  if (!fallback) throw badRequest('No enabled model can serve this request. Ask an administrator to configure model routing.');
  logger.warn('routing fell back to catalogue scan', { category, level });
  return buildRoute(catalog, fallback, null, { category, level, source: 'catalog_fallback' });
}

function buildRoute(catalog, model, rule, meta) {
  const provider = catalog.providers.get(model.provider_id);
  const fallbackId = rule?.fallback_model_id || model.fallback_model_id;
  const fallbackModel = fallbackId ? catalog.modelsById.get(fallbackId) : null;

  return {
    model,
    provider,
    fallback: fallbackModel
      ? { model: fallbackModel, provider: catalog.providers.get(fallbackModel.provider_id) }
      : null,
    category: meta.category,
    level: meta.level,
    source: meta.source,
    temperature: rule?.temperature ?? 0.2,
    maxOutputTokens: Math.min(rule?.max_output_tokens || model.max_output, model.max_output),
    maxInputTokens: rule?.max_input_tokens || Math.floor(model.context_window * 0.75),
    reasoningEffort: rule?.reasoning_effort && model.supports_reasoning ? rule.reasoning_effort : null
  };
}

/**
 * Escalate after a measured failure.
 * @returns {Promise<object|null>} a stronger route, or null when already at the ceiling.
 */
export async function escalate(current, { allowedTiers, attempt = 1 } = {}) {
  const defaults = await systemSetting('agent.defaults', { escalation_attempts: 2 });
  if (attempt > (defaults.escalation_attempts ?? 2)) return null;

  const nextIndex = levelIndex(current.level) + 1;
  if (nextIndex >= LEVELS.length) return null;

  const nextLevel = LEVELS[nextIndex];
  if (allowedTiers?.length && !allowedTiers.includes(nextLevel)) return null;

  const next = await route({ category: current.category, level: nextLevel, allowedTiers, requireTools: true });
  if (next.model.id === current.model.id) return null;   // no actual escalation available

  logger.info('escalating model', { from: current.model.code, to: next.model.code, level: nextLevel, attempt });
  return { ...next, escalatedFrom: current.model.code };
}

export { levelIndex };
