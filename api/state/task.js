const STATUSES = ['pending', 'planning', 'running', 'verifying', 'completed', 'failed', 'cancelled'];
const now = () => new Date().toISOString();
const id = () => `subtask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export function createTask(input = {}) {
  const task = {
    id: String(input.id || `task_${Date.now().toString(36)}`), title: String(input.title || '').trim().slice(0, 300),
    description: String(input.description || '').trim().slice(0, 10000), status: 'pending',
    subtasks: [], metrics: { attempts: 0, retries: 0, startedAt: null, completedAt: null, charsIn: 0, charsOut: 0 },
    createdAt: input.createdAt || now(), updatedAt: now(), error: null
  };
  if (!task.title && !task.description) task.title = 'Untitled task';
  return task;
}

export function setTaskStatus(task, status, error = null) {
  if (!task || !STATUSES.includes(status)) return task;
  const next = typeof structuredClone === 'function' ? structuredClone(task) : JSON.parse(JSON.stringify(task));
  next.status = status; next.updatedAt = now(); next.error = error ? String(error).slice(0, 2000) : null;
  if (status === 'running' && !next.metrics.startedAt) next.metrics.startedAt = next.updatedAt;
  if (['completed', 'failed', 'cancelled'].includes(status)) next.metrics.completedAt = next.updatedAt;
  return next;
}

export function addSubtask(task, title, options = {}) {
  if (!task || !String(title || '').trim()) return task;
  const next = typeof structuredClone === 'function' ? structuredClone(task) : JSON.parse(JSON.stringify(task));
  next.subtasks.push({ id: String(options.id || id()), title: String(title).trim().slice(0, 300), status: 'pending', result: '', error: null, createdAt: now(), updatedAt: now() });
  next.updatedAt = now(); return next;
}

export function updateSubtask(task, subtaskId, patch = {}) {
  if (!task || !subtaskId) return task;
  const next = typeof structuredClone === 'function' ? structuredClone(task) : JSON.parse(JSON.stringify(task));
  const item = next.subtasks.find(subtask => subtask.id === subtaskId);
  if (!item) return task;
  if (patch.status && STATUSES.includes(patch.status)) item.status = patch.status;
  if (patch.result !== undefined) item.result = String(patch.result).slice(0, 10000);
  if (patch.error !== undefined) item.error = patch.error ? String(patch.error).slice(0, 2000) : null;
  item.updatedAt = now(); next.updatedAt = item.updatedAt; return next;
}

export function recordMetrics(task, metrics = {}) {
  if (!task) return task;
  const next = typeof structuredClone === 'function' ? structuredClone(task) : JSON.parse(JSON.stringify(task));
  for (const key of ['attempts', 'retries', 'charsIn', 'charsOut']) {
    if (metrics[key] === undefined) continue;
    const value = Math.max(0, Number(metrics[key]) || 0);
    next.metrics[key] = metrics.increment ? next.metrics[key] + value : value;
  }
  next.updatedAt = now(); return next;
}

export { STATUSES };
