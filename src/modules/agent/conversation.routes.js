/**
 * Conversations.
 *
 * A conversation is the durable record of a working session with a project.
 * Older turns are folded into a rolling summary so a long conversation costs a
 * bounded number of tokens rather than growing without limit.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, t, uuid } from '../../core/validate.js';
import { badRequest, notFound } from '../../core/errors.js';
import { hasServiceRole, serviceClient } from '../../db/supabase.js';
import { complete } from '../../ai/gateway.js';
import { route } from '../../ai/router.js';
import { titlePrompt } from '../../agent/prompts.js';
import { logger } from '../../core/logger.js';

const MODES = ['ask', 'edit', 'agent', 'autopilot', 'review', 'debug', 'plan'];
const COMPACT_AFTER = 30;

function shapeConversation(row) {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    projectId: row.project_id,
    projectName: row.projects?.name ?? null,
    messageCount: row.message_count,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function shapeMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    sequence: row.sequence,
    taskId: row.task_id,
    tokens: row.tokens,
    costMicros: Number(row.cost_micros || 0),
    parts: (row.message_parts || []).sort((a, b) => a.position - b.position)
      .map(part => ({ kind: part.kind, payload: part.payload })),
    createdAt: row.created_at
  };
}

export function conversationRoutes() {
  const router = new Router();

  router.get('/', async ctx => {
    let query = ctx.auth.db.from('conversations').select('*,projects(id,name)')
      .eq('user_id', ctx.auth.user.id).is('archived_at', 'null');
    if (ctx.query.projectId) query = query.eq('project_id', parse(uuid({ required: true }), ctx.query.projectId));

    const rows = await query.order('updated_at').limit(Math.min(60, Number(ctx.query.limit) || 25)).all();
    return sendJson(ctx.res, 200, { conversations: rows.map(shapeConversation) });
  }, { auth: true });

  router.post('/', async ctx => {
    const body = parse(t.object({
      projectId: uuid(),
      title: t.string({ max: 120, truncate: true }),
      mode: t.enum(MODES, { default: 'agent' })
    }), await ctx.json());

    if (body.projectId) {
      const project = await ctx.auth.db.from('projects').select('id').eq('id', body.projectId).first();
      if (!project) throw notFound('Project not found');
    }

    const row = await ctx.auth.db.insert('conversations', {
      org_id: ctx.auth.org.id,
      user_id: ctx.auth.user.id,
      project_id: body.projectId ?? null,
      title: body.title || 'New conversation',
      mode: body.mode
    });

    return sendJson(ctx.res, 201, { conversation: shapeConversation(row) });
  }, { auth: 'write' });

  router.get('/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const conversation = await ctx.auth.db.from('conversations').select('*,projects(id,name)').eq('id', id).first();
    if (!conversation) throw notFound('Conversation not found');

    const messages = await ctx.auth.db.from('messages')
      .select('*,message_parts(kind,position,payload)')
      .eq('conversation_id', id)
      .eq('compacted', false)
      .order('sequence', { ascending: true })
      .limit(200)
      .all();

    return sendJson(ctx.res, 200, {
      conversation: shapeConversation(conversation),
      messages: messages.map(shapeMessage)
    });
  }, { auth: true });

  /**
   * Append a message.
   *
   * The client posts the user's turn here and then starts a task; the
   * assistant's turn is written back when the task finishes.
   */
  router.post('/:id/messages', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const conversation = await ctx.auth.db.from('conversations').select('*').eq('id', id).first();
    if (!conversation) throw notFound('Conversation not found');

    const body = parse(t.object({
      role: t.enum(['user', 'assistant'], { default: 'user' }),
      content: t.string({ required: true, max: 50_000 }),
      taskId: uuid(),
      parts: t.array(t.object({
        kind: t.enum(['text', 'code', 'diff', 'file_ref', 'tool_call', 'tool_result', 'activity', 'error', 'attachment', 'plan', 'review']),
        payload: t.object({}, { passthrough: true })
      }), { max: 40 })
    }), await ctx.json());

    const sequence = (conversation.message_count || 0) + 1;

    const message = await ctx.auth.db.insert('messages', {
      conversation_id: id,
      task_id: body.taskId ?? null,
      role: body.role,
      content: body.content,
      sequence,
      tokens: Math.ceil(body.content.length / 3.6)
    });

    if (body.parts?.length) {
      await ctx.auth.db.insert('message_parts', body.parts.map((part, index) => ({
        message_id: message.id, kind: part.kind, position: index, payload: part.payload ?? {}
      })), { returning: false });
    }

    await ctx.auth.db.from('conversations').eq('id', id).update({ message_count: sequence });

    // Title the conversation from its first real turn, using the cheapest model.
    if (sequence === 1 && body.role === 'user' && conversation.title === 'New conversation') {
      titleConversation(id, body.content, ctx.auth).catch(() => {});
    }

    // Fold older turns into the summary once the conversation gets long.
    if (sequence > COMPACT_AFTER && sequence % 10 === 0) {
      compactConversation(id, ctx.auth).catch(error =>
        logger.debug('conversation compaction skipped', { reason: error?.message }));
    }

    return sendJson(ctx.res, 201, { message: shapeMessage({ ...message, message_parts: [] }) });
  }, { auth: 'write' });

  router.patch('/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const body = parse(t.object({
      title: t.string({ max: 120, truncate: true }),
      mode: t.enum(MODES),
      archived: t.boolean()
    }), await ctx.json());

    const patch = {};
    if (body.title) patch.title = body.title;
    if (body.mode) patch.mode = body.mode;
    if (body.archived !== undefined) patch.archived_at = body.archived ? new Date().toISOString() : null;
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const [row] = await ctx.auth.db.from('conversations').eq('id', id).update(patch);
    if (!row) throw notFound('Conversation not found');
    return sendJson(ctx.res, 200, { conversation: shapeConversation(row) });
  }, { auth: 'write' });

  router.delete('/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    await ctx.auth.db.from('conversations').eq('id', id).eq('user_id', ctx.auth.user.id).remove();
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: 'write' });

  return router;
}

/** Cheapest model, cached, ~20 output tokens. */
async function titleConversation(conversationId, text, auth) {
  const titleRoute = await route({ category: 'title', level: 'level0' });
  const result = await complete({
    messages: titlePrompt(text),
    routeResult: titleRoute,
    temperature: 0.3,
    maxTokens: 24,
    cache: true,
    context: { orgId: auth.org.id, userId: auth.user.id }
  });

  const title = result.text.replace(/^["']|["']$/g, '').trim().slice(0, 80);
  if (title) await auth.db.from('conversations').eq('id', conversationId).update({ title });
}

/**
 * Rolling compaction.
 *
 * Older messages are marked compacted and replaced by a summary line, which is
 * what the context engine reads. The originals stay in the database so the user
 * can still scroll back — only the model's view shrinks.
 */
async function compactConversation(conversationId, auth) {
  if (!hasServiceRole()) return;
  const client = serviceClient();

  const conversation = await client.from('conversations').select('summary,summarized_through,message_count').eq('id', conversationId).first();
  if (!conversation) return;

  const from = conversation.summarized_through || 0;
  const to = Math.max(from, (conversation.message_count || 0) - 12);
  if (to - from < 8) return;

  const messages = await client.from('messages')
    .select('role,content,sequence')
    .eq('conversation_id', conversationId)
    .gt('sequence', from).lte('sequence', to)
    .order('sequence', { ascending: true }).limit(60).all();
  if (!messages.length) return;

  const transcript = messages
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${String(message.content).replace(/```[\s\S]*?```/g, '[code]').slice(0, 400)}`)
    .join('\n');

  const summaryRoute = await route({ category: 'summarize', level: 'level0' });
  const result = await complete({
    messages: [
      { role: 'system', content: 'Summarise this conversation between a developer and a coding agent in at most 150 words. Keep decisions, constraints and unresolved issues. Drop pleasantries.' },
      { role: 'user', content: `${conversation.summary ? `Earlier summary:\n${conversation.summary}\n\nNew turns:\n` : ''}${transcript}` }
    ],
    routeResult: summaryRoute,
    temperature: 0,
    maxTokens: 400,
    context: { orgId: auth.org.id, userId: auth.user.id }
  });

  await client.from('conversations').eq('id', conversationId).update({
    summary: result.text.slice(0, 4000),
    summary_tokens: result.usage.outputTokens,
    summarized_through: to
  });

  await client.from('messages').eq('conversation_id', conversationId)
    .gt('sequence', from).lte('sequence', to).update({ compacted: true });

  logger.debug('conversation compacted', { conversationId, from, to });
}

export { shapeConversation, shapeMessage, compactConversation };
