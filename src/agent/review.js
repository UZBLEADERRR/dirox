/**
 * AI code review.
 *
 * Reviews the actual diff, not the whole repository — a review of unchanged
 * code is both wrong and expensive. Findings are stored so they can be listed,
 * fixed and marked resolved.
 */

import { complete } from '../ai/gateway.js';
import { route } from '../ai/router.js';
import { reviewPrompt } from './prompts.js';
import { runCommand } from '../exec/sandbox.js';
import { serviceClient, hasServiceRole } from '../db/supabase.js';
import { readWorkspaceFile } from '../exec/workspace.js';
import { badRequest } from '../core/errors.js';
import { logger } from '../core/logger.js';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const CATEGORIES = ['correctness', 'security', 'performance', 'maintainability', 'test'];
const MAX_DIFF_CHARS = 60_000;

/**
 * Build the diff to review.
 *
 * Prefers git, because a real diff shows exactly what changed. Without git,
 * falls back to the current contents of the changed files, which is worse but
 * still bounded and truthful about what it is.
 */
export async function buildReviewDiff(projectId, changedFiles = []) {
  const gitDiff = await runCommand(projectId, 'git diff HEAD', {
    timeoutMs: 30_000, maxOutput: MAX_DIFF_CHARS
  }).catch(() => null);

  if (gitDiff?.ok && gitDiff.stdout.trim()) {
    return { diff: gitDiff.stdout, source: 'git', truncated: gitDiff.truncated };
  }

  if (!changedFiles.length) return { diff: '', source: 'none', truncated: false };

  const parts = [];
  let total = 0;
  for (const file of changedFiles.slice(0, 20)) {
    const path = typeof file === 'string' ? file : file.path;
    const content = await readWorkspaceFile(projectId, path).catch(() => null);
    if (!content) continue;
    const block = `--- a/${path}\n+++ b/${path}\n${content.content.split('\n').map(line => `+${line}`).join('\n')}`;
    if (total + block.length > MAX_DIFF_CHARS) break;
    parts.push(block);
    total += block.length;
  }

  return { diff: parts.join('\n\n'), source: 'files', truncated: parts.length < changedFiles.length };
}

/**
 * Review a change.
 * @returns {Promise<{findings:Array, costMicros:number, model:string}>}
 */
export async function reviewChange({ projectId, taskId, orgId, userId, project, changedFiles = [], allowedTiers, level = 'level2', signal }) {
  const { diff, source, truncated } = await buildReviewDiff(projectId, changedFiles);
  if (!diff.trim()) return { findings: [], costMicros: 0, model: null, skipped: 'nothing changed' };

  const reviewRoute = await route({ category: 'review', level, allowedTiers });

  const result = await complete({
    messages: reviewPrompt(diff, { project }),
    routeResult: reviewRoute,
    temperature: 0,
    maxTokens: Math.min(6000, reviewRoute.maxOutputTokens),
    responseFormat: 'json',
    signal,
    context: { orgId, userId, projectId, taskId }
  });

  const findings = parseFindings(result.text);

  if (findings.length && hasServiceRole()) {
    await serviceClient().insert('review_findings', findings.map(finding => ({
      project_id: projectId,
      task_id: taskId ?? null,
      severity: finding.severity,
      category: finding.category,
      file_path: finding.file,
      line: finding.line,
      title: finding.title,
      detail: finding.detail,
      suggestion: finding.suggestion
    })), { returning: false }).catch(error =>
      logger.warn('review findings not stored', { reason: error?.message }));
  }

  logger.info('review completed', {
    projectId, taskId, findings: findings.length, source, truncated, model: reviewRoute.model.code
  });

  return {
    findings,
    costMicros: result.costMicros,
    model: reviewRoute.model.name,
    diffSource: source,
    truncated
  };
}

/** Parse the model's JSON, discarding anything that does not fit the contract. */
export function parseFindings(text) {
  let parsed;
  try {
    const match = String(text).match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text);
  } catch {
    return [];
  }

  const raw = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = [];

  for (const item of raw.slice(0, 40)) {
    const severity = SEVERITIES.includes(item.severity) ? item.severity : 'info';
    const title = String(item.title || '').trim().slice(0, 200);
    if (!title) continue;

    findings.push({
      severity,
      category: CATEGORIES.includes(item.category) ? item.category : 'correctness',
      file: item.file ? String(item.file).slice(0, 300) : null,
      line: Number.isInteger(item.line) && item.line > 0 ? item.line : null,
      title,
      detail: String(item.detail || '').slice(0, 1500),
      suggestion: item.suggestion ? String(item.suggestion).slice(0, 1500) : null
    });
  }

  const order = Object.fromEntries(SEVERITIES.map((severity, index) => [severity, index]));
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** A one-line verdict for the activity timeline. */
export function summariseFindings(findings) {
  if (!findings.length) return 'No findings';
  const counts = {};
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  return SEVERITIES
    .filter(severity => counts[severity])
    .map(severity => `${counts[severity]} ${severity}`)
    .join(', ');
}

export { SEVERITIES, CATEGORIES };
