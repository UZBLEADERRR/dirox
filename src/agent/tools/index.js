/**
 * Tool registry and executor.
 *
 * Every tool call goes through `executeTool`, which is the single place that:
 *   - validates arguments against the tool's declared schema
 *   - resolves the permission decision (allow / ask / deny)
 *   - enforces a timeout and supports cancellation
 *   - truncates and records output
 *   - records the call and its result for the task timeline
 *
 * A tool implementation never has to think about any of that.
 */

import { fileTools } from './files.js';
import { terminalTools } from './terminal.js';
import { gitTools } from './git.js';
import { githubTools, GITHUB_TOOL_NAMES } from './github.js';
import { deliverTools } from './deliver.js';
import { projectTools } from './project.js';
import { previewTools } from './preview.js';
import { parse, toJsonSchema } from '../../core/validate.js';
import { AppError, badRequest, forbidden, notFound, timedOut, toAppError } from '../../core/errors.js';
import { decide, describeApproval, RISK } from '../permissions.js';
import { truncateToolOutput } from '../../context/engine.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { runtimeStats } from '../../modules/observability/audit.js';
import { logger } from '../../core/logger.js';

const ALL_TOOLS = [
  ...fileTools, ...terminalTools, ...gitTools, ...githubTools,
  ...deliverTools, ...projectTools, ...previewTools
];
const BY_NAME = new Map(ALL_TOOLS.map(tool => [tool.name, tool]));

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The tools available for a given mode.
 *
 * Read-only modes get read-only tools — not by convention but by construction,
 * so a model in review mode has no write tool to call in the first place.
 */
const PREVIEW_TOOL_NAMES = new Set(previewTools.map(tool => tool.name));

/**
 * Toolsets by intent.
 *
 * Tool schemas are the largest fixed cost in an agent request — all 32 of them
 * come to roughly 3,600 tokens, sent on every call whether or not any will be
 * used. A greeting needs none of them; a question needs the six that read.
 *
 * `read` is deliberately small rather than "everything non-destructive":
 * offering fifteen ways to look something up makes the model try several. It
 * omits project inspection and memory recall because retrieval already puts
 * both in front of the model — paying for the schema as well is paying twice.
 */
/**
 * The GitHub tools a question can need. Added to a small toolset only when the
 * message actually mentions GitHub: they are cheap individually and about 400
 * tokens together, which is most of a cheap question's budget.
 */
const GITHUB_READ = ['github_account', 'github_repositories', 'github_pull_requests', 'github_issues', 'github_checks'];

const TOOLSETS = {
  none: [],
  read: ['read_file', 'search_code', 'find_symbol', 'list_directory'],
  full: null   // everything the mode and flags allow
};

/**
 * @param {{mode?:string, intent?:string, toolset?:string, featureFlags?:object,
 *          hasRepository?:boolean, hasDevCommand?:boolean, hasGitHub?:boolean,
 *          includeGitHub?:boolean}} options
 */
export function toolsFor({
  mode = 'agent', toolset, featureFlags = {}, includeGitHub = false,
  hasRepository = false, hasDevCommand = false, hasGitHub = true
} = {}) {
  // The intent profile decides first: it can refuse tools outright, which no
  // amount of later filtering can do as cheaply.
  if (toolset === 'none') return [];

  let tools = ALL_TOOLS;

  if (toolset && TOOLSETS[toolset]) {
    const allowed = new Set(TOOLSETS[toolset]);
    if (includeGitHub) for (const name of GITHUB_READ) allowed.add(name);
    tools = tools.filter(tool => allowed.has(tool.name));
  }

  if (mode === 'ask' || mode === 'review' || mode === 'plan') {
    tools = tools.filter(tool => tool.risk === RISK.SAFE);
  }
  if (mode === 'edit') {
    tools = tools.filter(tool => [RISK.SAFE, RISK.WRITE].includes(tool.risk) && !tool.name.startsWith('git_'));
  }
  // `git_*` works on the checked-out workspace, so it needs one. `github_*`
  // talks to the user's account and does not: "which repositories do I have"
  // is a fair question to ask before any of them is open.
  if (!hasRepository) {
    tools = tools.filter(tool => !tool.name.startsWith('git_') && tool.name !== 'deliver_file');
  }
  if (featureFlags.github === false || !hasGitHub) {
    tools = tools.filter(tool => !GITHUB_TOOL_NAMES.has(tool.name));
  }
  if (featureFlags.terminal === false) {
    tools = tools.filter(tool => !['execute_command', 'run_tests', 'run_build', 'run_linter', 'install_dependency', 'dependency_audit'].includes(tool.name));
  }
  // The preview agent needs a dev server; without one the tools would only
  // ever return an error, so they are not offered at all.
  if (featureFlags.visual_agent === false || !hasDevCommand) {
    tools = tools.filter(tool => !PREVIEW_TOOL_NAMES.has(tool.name));
  }

  return tools;
}

/** The tool definitions sent to the model. */
export function toolDefinitions(tools) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    schema: tool.schema
  }));
}

export function getTool(name) { return BY_NAME.get(name) ?? null; }
export function allTools() { return ALL_TOOLS; }

/**
 * @param {{name:string, arguments:object, id:string}} call
 * @param {object} ctx  execution context: projectId, project, userId, taskId,
 *                      trust, mode, role, signal, recordFileChange, onOutput
 * @returns {Promise<{ok:boolean, output:string, metadata:object, status:string, approval?:object}>}
 */
export async function executeTool(call, ctx) {
  const tool = BY_NAME.get(call.name);
  const started = Date.now();

  if (!tool) {
    return {
      ok: false, status: 'failed',
      output: `There is no tool called "${call.name}". Available: ${[...BY_NAME.keys()].join(', ')}.`,
      metadata: {}
    };
  }

  // ── validate ──
  let args;
  try {
    args = parse(tool.schema, call.arguments ?? {});
  } catch (error) {
    const details = error.details?.map(detail => `${detail.path} ${detail.message}`).join('; ') || error.message;
    return {
      ok: false, status: 'failed',
      output: `Invalid arguments for ${tool.name}: ${details}`,
      metadata: { validation: error.details }
    };
  }

  // ── permission ──
  // Some tools compute risk from their arguments (a command's risk depends on
  // the command), so the effective risk is resolved per call.
  const effectiveRisk = tool.riskFor ? await tool.riskFor(args, ctx) : tool.risk;
  const decision = decide({ ...tool, risk: effectiveRisk }, { trust: ctx.trust, mode: ctx.mode, role: ctx.role });

  if (decision.decision === 'deny') {
    await recordCall(ctx, call, args, 'denied', { output: decision.reason }, Date.now() - started);
    return { ok: false, status: 'denied', output: `Not permitted: ${decision.reason}`, metadata: { risk: effectiveRisk } };
  }

  if (decision.decision === 'ask' && !ctx.approvedCalls?.has(call.id)) {
    const approval = {
      toolCallId: call.id,
      tool: tool.name,
      risk: effectiveRisk,
      description: describeApproval(tool, args),
      arguments: args
    };
    await recordCall(ctx, call, args, 'awaiting_approval', {}, Date.now() - started);
    return { ok: false, status: 'awaiting_approval', output: `Waiting for approval: ${approval.description}`, metadata: {}, approval };
  }

  // ── run ──
  const controller = new AbortController();
  const timeoutMs = tool.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  ctx.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const result = await tool.run(args, { ...ctx, signal: controller.signal });
    const durationMs = Date.now() - started;

    const output = truncateToolOutput(result.output ?? '', ctx.toolOutputLimit ?? 6000);
    const ok = result.ok !== false;
    runtimeStats.tool(!ok);

    await recordCall(ctx, call, args, ok ? 'completed' : 'failed', { output, metadata: result.metadata }, durationMs);

    return {
      ok,
      status: ok ? 'completed' : 'failed',
      output,
      metadata: result.metadata ?? {},
      durationMs,
      truncated: output.length < String(result.output ?? '').length
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const app = toAppError(error);
    const message = controller.signal.aborted && !ctx.signal?.aborted
      ? `${tool.name} timed out after ${Math.round(timeoutMs / 1000)}s`
      : app.message;

    runtimeStats.tool(true);
    logger.debug('tool failed', { tool: tool.name, code: app.code, message });
    await recordCall(ctx, call, args, 'failed', { output: message }, durationMs);

    return { ok: false, status: 'failed', output: message, metadata: { code: app.code }, durationMs };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist the call and its result.
 *
 * Arguments are stored, but any argument holding file content is replaced with
 * its size: the task timeline should be readable, and storing a 400KB file body
 * three times over is neither useful nor cheap.
 */
async function recordCall(ctx, call, args, status, result, durationMs) {
  if (!hasServiceRole() || !ctx.taskId) return;
  try {
    const client = serviceClient();
    const row = await client.insert('tool_calls', {
      task_id: ctx.taskId,
      step_id: ctx.stepId ?? null,
      tool: call.name,
      arguments: summariseArgs(args),
      status,
      duration_ms: Math.round(durationMs),
      approved_by: ctx.approvedCalls?.has(call.id) ? ctx.userId : null,
      approved_at: ctx.approvedCalls?.has(call.id) ? new Date().toISOString() : null
    });

    if (row?.id && (status === 'completed' || status === 'failed')) {
      await client.insert('tool_results', {
        tool_call_id: row.id,
        ok: status === 'completed',
        output: String(result.output ?? '').slice(0, 20_000),
        output_tokens: Math.ceil(String(result.output ?? '').length / 3.6),
        truncated: Boolean(result.truncated),
        metadata: result.metadata ?? {},
        error: status === 'failed' ? String(result.output ?? '').slice(0, 500) : null
      }, { returning: false });
    }
  } catch (error) {
    logger.debug('tool call not recorded', { reason: error?.message });
  }
}

function summariseArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (typeof value === 'string' && value.length > 500) {
      out[key] = `[${value.length} characters]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export { ALL_TOOLS, summariseArgs, DEFAULT_TIMEOUT_MS };
