/**
 * Intent router.
 *
 * The first decision, taken before anything is assembled. Complexity routing
 * decides *which model*; intent routing decides *how much to send it at all*.
 *
 * Without this, a greeting costs the same as a refactor: the full system
 * prompt, every tool schema and a retrieval pass. That is the single largest
 * source of wasted tokens in an agent, because trivial messages are the most
 * common ones.
 *
 *   chat   nothing to look up. Tiny prompt, no tools, no retrieval.
 *   ask    a question about the code. Read-only tools, retrieval, no writes.
 *   code   real work. The full pipeline.
 *
 * Each intent carries a profile that every later stage reads, so there is one
 * place that decides what a request is allowed to cost.
 */

const GREETING = /^(hi|hey|hello|yo|salom|assalom|привет|안녕|hola|good (morning|afternoon|evening))\b/i;
const COURTESY = /^(thanks?|thank you|rahmat|спасибо|ok(ay)?|got it|nice|cool|great|perfect|sure|yes|no|yep|nope|bye|👍|🙏|❤️)\W*$/i;
const META = /\b(who are you|what (can|do) you do|what are you|how do you work|kim(san|siz)|nima qila olasan)\b/i;

/** Signals that the message is about this codebase rather than in general. */
const CODEBASE = /\b(this (code|project|repo|file|function|component)|the (codebase|project|repo)|my (code|project|app)|explain|where is|how does .* work|why (does|is)|what does .* do)\b/i;

/** Signals that something must actually change. */
const MUTATION = /\b(add|create|build|implement|write|fix|repair|refactor|rename|move|delete|remove|update|change|modify|migrate|install|integrate|optimi[sz]e|upgrade|test|deploy|generate|setup|set up)\b/i;

/** Signals a failure to diagnose. */
const FAILURE = /\b(error|exception|stack ?trace|traceback|crash|fail(s|ed|ing)?|broken|not working|doesn'?t work|bug|500|404|undefined is not|cannot read)\b/i;

export const INTENTS = ['chat', 'ask', 'code'];

/**
 * Profiles.
 *
 * `promptTier` and `toolset` are the two that matter most: together they are
 * roughly 4,300 tokens on a request that needs neither.
 */
export const PROFILES = {
  chat: {
    intent: 'chat',
    promptTier: 'minimal',
    toolset: 'none',
    retrieval: false,
    historyTurns: 4,
    historyChars: 300,
    maxOutputTokens: 400,
    category: 'chat',
    level: 'level0',
    cacheable: true
  },
  ask: {
    intent: 'ask',
    promptTier: 'compact',
    toolset: 'read',
    retrieval: true,
    historyTurns: 8,
    historyChars: 3000,
    maxOutputTokens: 2000,
    category: 'chat',
    level: 'level1',
    cacheable: true
  },
  code: {
    intent: 'code',
    promptTier: 'full',
    toolset: 'full',
    retrieval: true,
    historyTurns: 12,
    historyChars: 0,        // the loop's own turns carry tool output; the budget bounds them
    maxOutputTokens: null,     // the budget engine decides
    category: 'code',
    level: null,               // the complexity classifier decides
    cacheable: true
  }
};

/**
 * Classify intent from the message alone. Costs nothing.
 *
 * @param {{text:string, mode?:string, hasProject?:boolean, hasAttachment?:boolean, conversationTurns?:number}} input
 * @returns {{intent:string, profile:object, confidence:number, reason:string}}
 */
export function classifyIntent({ text = '', mode = 'agent', hasProject = false, hasAttachment = false, conversationTurns = 0 } = {}) {
  const source = String(text).trim();
  const words = source.split(/\s+/).filter(Boolean).length;

  const decide = (intent, confidence, reason) => ({
    intent, profile: PROFILES[intent], confidence, reason
  });

  // An explicit mode is a stated intent; it outranks any guess.
  if (mode === 'ask') return decide('ask', 1, 'ask mode selected');
  if (['edit', 'agent', 'autopilot', 'debug', 'review', 'plan'].includes(mode) && mode !== 'agent') {
    return decide('code', 1, `${mode} mode selected`);
  }

  // Anything attached is there to be looked at.
  if (hasAttachment) return decide('code', 0.9, 'an attachment was supplied');

  // ── chat: nothing to look up ──
  if (COURTESY.test(source)) return decide('chat', 0.98, 'courtesy message');
  if (GREETING.test(source) && words <= 6) return decide('chat', 0.97, 'greeting');
  if (META.test(source)) return decide('chat', 0.9, 'question about DiroxCode itself');
  if (words <= 2 && !MUTATION.test(source)) return decide('chat', 0.85, 'too short to reference anything');

  // Without a project there is nothing to retrieve or edit, so the heavy
  // pipeline cannot help no matter what the message says.
  if (!hasProject) {
    return decide(MUTATION.test(source) || FAILURE.test(source) ? 'ask' : 'chat', 0.8, 'no project is open');
  }

  // ── code: something must change, or something is broken ──
  if (FAILURE.test(source)) return decide('code', 0.9, 'reports a failure to diagnose');
  if (MUTATION.test(source)) return decide('code', 0.9, 'asks for a change');

  // ── ask: a question about the codebase ──
  if (CODEBASE.test(source)) return decide('ask', 0.85, 'question about the codebase');
  if (/^(what|why|how|where|which|when|who|does|is|are|can|should)\b/i.test(source)) {
    return decide('ask', 0.7, 'phrased as a question');
  }

  // Long and unmatched usually means a specification.
  if (words > 40) return decide('code', 0.6, 'long, detailed request');

  // Genuinely unclear. `ask` is the right default: it can read but not write,
  // so a wrong guess costs some retrieval rather than an unwanted edit.
  return decide('ask', 0.45, 'intent unclear, defaulting to read-only');
}

/** The prompt used when the heuristic is not confident enough to commit. */
export function intentPrompt(text) {
  return [
    {
      role: 'system',
      content: [
        'Classify one message from a developer to a coding assistant.',
        'Reply with JSON only: {"intent":"chat|ask|code"}',
        '',
        'chat = greeting, thanks, or a question needing no access to their code',
        'ask  = a question about their codebase, answerable without changing anything',
        'code = something must be written, changed, fixed or run',
        '',
        'Choose the cheapest that can succeed.'
      ].join('\n')
    },
    { role: 'user', content: String(text).slice(0, 500) }
  ];
}

export function parseIntent(text, fallback) {
  try {
    const match = String(text).match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    if (!INTENTS.includes(parsed.intent)) return fallback;
    return { intent: parsed.intent, profile: PROFILES[parsed.intent], confidence: 0.9, reason: 'classified by model' };
  } catch {
    return fallback;
  }
}

/** Is a model call worth making to settle this? Only when it can save more. */
export function shouldVerifyIntent(result) {
  // Verifying costs ~120 tokens. Getting `chat` wrong and running the full
  // pipeline costs thousands, so only low confidence on a heavy intent pays.
  return result.confidence < 0.6 && result.intent !== 'chat';
}
