const TYPES = new Set(['permanent', 'task', 'conversation']);
const MAX_TEXT = 4000;

const clean = (value, max = MAX_TEXT) => String(value ?? '').trim().slice(0, max);

export function createMemory(initial = {}) {
  return {
    permanent: normalizeList(initial.permanent),
    task: normalizeList(initial.task),
    conversation: normalizeList(initial.conversation)
  };
}
function normalizeList(list) { return Array.isArray(list) ? list.map(item => typeof item === 'string' ? item : item?.text).filter(Boolean).map(item => clean(item)) : []; }

export function addMemory(memory, type, value, options = {}) {
  if (!TYPES.has(type) || !value || typeof memory !== 'object') return createMemory(memory);
  const next = createMemory(memory);
  const text = clean(value, options.maxChars || MAX_TEXT);
  if (!text) return next;
  if (options.replace) next[type] = [text];
  else if (!next[type].some(item => item.toLowerCase() === text.toLowerCase())) next[type].push(text);
  const maxItems = Math.max(1, Number(options.maxItems) || (type === 'conversation' ? 30 : 50));
  next[type] = next[type].slice(-maxItems);
  return next;
}

export function clearMemory(memory, type) {
  const next = createMemory(memory);
  if (TYPES.has(type)) next[type] = [];
  return next;
}

export function compactSummary(values, maxChars = 1600) {
  const list = Array.isArray(values) ? values : [values];
  const seen = new Set(); const lines = [];
  for (const value of list) {
    const line = clean(value, 500).replace(/\s+/g, ' ');
    const key = line.toLowerCase();
    if (line && !seen.has(key)) { seen.add(key); lines.push(`- ${line}`); }
  }
  return lines.join('\n').slice(0, Math.max(0, Number(maxChars) || 1600));
}

export function summarizeMemory(memory, maxChars = 3000) {
  const source = createMemory(memory);
  const sections = ['permanent', 'task', 'conversation'].filter(type => source[type].length).map(type => `${type.toUpperCase()}:\n${compactSummary(source[type])}`);
  return sections.join('\n').slice(0, maxChars);
}

export { TYPES };
