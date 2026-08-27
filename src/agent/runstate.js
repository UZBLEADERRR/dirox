/**
 * A run you can pick back up.
 *
 * Until now a task run lived entirely in one function's local variables. That
 * is fine while nothing interrupts it, and nothing interrupts it right up to
 * the moment something does: a deploy replaces the container, an approval
 * pauses the loop, a browser closes, a worker is reclaimed. Every one of those
 * threw away the conversation, the tool groups the run had paid a round trip
 * to load, and the tool call that was waiting for a person to say yes. The
 * only recovery was to start over, and starting over costs the money again.
 *
 * So the loop writes down what it would need to continue, and continuing is
 * reading it back. Two rules keep this cheap rather than clever:
 *
 *   1. Bounded. A run that goes long must not write a growing blob on every
 *      step, so the conversation is trimmed and each message is capped before
 *      it is stored. What survives is what the model would have been sent
 *      anyway — the recent turns, not the whole history.
 *   2. Advisory. A restored state is never trusted to be complete or current.
 *      Anything missing falls back to a fresh start, because a run that
 *      resumes wrongly is worse than one that resumes from the beginning.
 */

/** How many conversation messages a stored state keeps. */
const KEEP_MESSAGES = 16;

/** How much of one message survives. Enough to be useful, not a transcript. */
const MESSAGE_CHARS = 4000;

/** A stored state larger than this is not worth writing back. */
const MAX_CHARS = 400_000;

/**
 * Trim one conversation message to what a resumed run actually needs.
 *
 * `tool_calls` and `tool_call_id` are preserved exactly: without them the
 * model cannot tell which call produced which result, and providers reject a
 * tool result whose call it cannot find.
 */
function packMessage(message) {
  const packed = {
    role: message.role,
    content: String(message.content ?? '').slice(0, MESSAGE_CHARS)
  };
  if (message.tool_call_id) packed.tool_call_id = message.tool_call_id;
  if (message.name) packed.name = message.name;
  if (Array.isArray(message.tool_calls)) {
    packed.tool_calls = message.tool_calls.map(call => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.function?.name ?? call.name,
        arguments: String(call.function?.arguments ?? '{}').slice(0, MESSAGE_CHARS)
      }
    }));
  }
  return packed;
}

/**
 * Trim a conversation to its most recent turns without orphaning a tool result.
 *
 * A window that starts in the middle of a tool round leaves results whose
 * assistant turn is no longer there. Providers reject that outright — an
 * OpenAI tool message must follow the assistant message that requested it —
 * so the window is moved forward until it begins on a whole turn.
 *
 * Slicing without this is the kind of bug that only appears on long runs,
 * which is exactly when the trim starts happening.
 */
export function trimConversation(messages, keep = KEEP_MESSAGES) {
  const window = messages.slice(-keep);
  let start = 0;
  while (start < window.length && window[start].role === 'tool') start += 1;
  return window.slice(start);
}

/**
 * What the loop would need to continue from here.
 *
 * @param {object} state    the orchestrator's mutable run state
 * @param {object} extra    { iteration, category, level, finalText, pendingCalls }
 */
export function packRunState(state, extra = {}) {
  const packed = {
    version: 1,
    iteration: Number(extra.iteration || 0),
    stepIndex: Number(state.stepIndex || 0),
    category: extra.category ?? null,
    level: extra.level ?? null,
    // A half-finished run must not be re-read as a different kind of request.
    // Re-deriving the intent from the same objective is usually stable, but
    // "usually" here means a resumed coding run occasionally comes back as a
    // question and loses every tool it had.
    intent: extra.intent ?? null,
    // Whether the person has seen the plan and said go. A resumed run must
    // never ask a second time — being asked twice for the same permission
    // reads as the product having forgotten.
    planApproved: Boolean(extra.planApproved),
    planProgress: Object.fromEntries(state.planProgress ?? []),
    escalations: Number(state.escalations || 0),
    checkpointId: state.checkpointId ?? null,
    finalText: String(extra.finalText || '').slice(0, 4000),
    loadedGroups: [...(state.loadedGroups ?? [])],
    changedFiles: [...(state.changedFiles?.values() ?? [])].slice(0, 400),
    deliverables: (state.deliverables ?? []).slice(0, 50),
    // Delegated jobs count against a per-task limit, so a resumed run that
    // forgot them could split the same work indefinitely.
    children: (state.children ?? []).slice(0, 20),
    recentActions: (state.recentActions ?? []).slice(-12),
    // Calls that never ran: the one that stopped for approval, and everything
    // queued behind it. Resuming means running these before asking the model
    // for anything new — otherwise the conversation carries an assistant turn
    // whose tool calls have no results, which every provider rejects.
    pendingCalls: (extra.pendingCalls ?? []).slice(0, 8).map(call => ({
      id: call.id, name: call.name, arguments: call.arguments ?? {}
    })),
    conversation: trimConversation(state.conversation ?? []).map(packMessage),
    savedAt: new Date().toISOString()
  };

  // A state too large to store is a state we would rather not have: dropping
  // the conversation keeps the cheap half — the groups, the changed files and
  // the pending calls — rather than losing all of it.
  if (JSON.stringify(packed).length > MAX_CHARS) {
    packed.conversation = trimConversation(packed.conversation, 4);
    packed.truncated = true;
  }
  return packed;
}

/**
 * Read a stored state back, or decide there is nothing to resume.
 *
 * @returns {null|{iteration:number, conversation:Array, changedFiles:Array,
 *                 loadedGroups:string[], pendingCalls:Array, ...}}
 */
export function unpackRunState(stored) {
  if (!stored || typeof stored !== 'object') return null;
  if (stored.version !== 1) return null;
  // A state with nothing in it is not a resumable run; it is an empty column.
  const conversation = Array.isArray(stored.conversation) ? stored.conversation : [];
  const pendingCalls = Array.isArray(stored.pendingCalls) ? stored.pendingCalls : [];
  // A plan waiting on a person is a resumable run that has not said anything
  // yet: no conversation, no pending calls, and everything still to do.
  if (!conversation.length && !pendingCalls.length && !stored.planApproved) return null;

  return {
    iteration: Number(stored.iteration) || 0,
    stepIndex: Number(stored.stepIndex) || 0,
    category: stored.category ?? null,
    level: stored.level ?? null,
    intent: typeof stored.intent === 'string' ? stored.intent : null,
    planApproved: Boolean(stored.planApproved),
    planProgress: stored.planProgress && typeof stored.planProgress === 'object' ? stored.planProgress : {},
    escalations: Number(stored.escalations) || 0,
    checkpointId: stored.checkpointId ?? null,
    finalText: String(stored.finalText || ''),
    loadedGroups: Array.isArray(stored.loadedGroups) ? stored.loadedGroups.filter(name => typeof name === 'string') : [],
    changedFiles: (Array.isArray(stored.changedFiles) ? stored.changedFiles : [])
      .filter(file => file && typeof file.path === 'string'),
    deliverables: Array.isArray(stored.deliverables) ? stored.deliverables : [],
    children: Array.isArray(stored.children) ? stored.children : [],
    recentActions: Array.isArray(stored.recentActions) ? stored.recentActions : [],
    pendingCalls: pendingCalls.filter(call => call && typeof call.name === 'string'),
    conversation: conversation.filter(message => message && typeof message.role === 'string'),
    savedAt: stored.savedAt ?? null
  };
}

export { KEEP_MESSAGES, MESSAGE_CHARS, MAX_CHARS, packMessage };
