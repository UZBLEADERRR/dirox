const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);

function fallbackPlan(task = {}) {
  const title = clean(task.title || task.description || 'Complete the task', 300) || 'Complete the task';
  return {
    subtasks: [{ title }],
    successCriteria: ['The requested behavior is implemented', 'Relevant tests or checks pass']
  };
}

function parsePlan(value, task) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    const subtasks = Array.isArray(parsed.subtasks) ? parsed.subtasks
      .map(item => clean(typeof item === 'string' ? item : item?.title, 300)).filter(Boolean).slice(0, 20) : [];
    const successCriteria = Array.isArray(parsed.successCriteria) ? parsed.successCriteria
      .map(item => clean(item, 300)).filter(Boolean).slice(0, 10) : [];
    if (!subtasks.length || !successCriteria.length) return fallbackPlan(task);
    return { subtasks, successCriteria };
  } catch { return fallbackPlan(task); }
}

/** Parse a compact planner response. The planner is deliberately deterministic and cheap. */
export function planTask(task = {}, response = null) {
  return parsePlan(response, task);
}

export function plannerPrompt(task = {}) {
  return `Return JSON only: {"subtasks":["..."],"successCriteria":["..."]}. Task: ${clean(task.title)}\n${clean(task.description, 1800)}`;
}

export { fallbackPlan, parsePlan };
export default planTask;
