/**
 * Parallel writers.
 *
 * A twenty-lesson course written by one agent is twenty round trips through a
 * conversation that grows the whole way: by the last lesson the model is
 * paying to re-read nineteen tool results it no longer needs. Worse, it is
 * slow — the user watches a spinner for several minutes.
 *
 * So the bulk of the writing is fanned out. Each worker is a single request
 * with a small, purpose-built context: the course it belongs to, its own
 * lesson, what came before and after, and the markup it may use. Nothing
 * accumulates, several run at once, and each reports its own progress row.
 *
 * The main agent still owns the plan, the checks and the fixes. Workers only
 * write one body each — the part that parallelises cleanly because lessons do
 * not depend on each other's text.
 */

import { stream } from './llm.js';

const DEFAULT_WORKERS = 4;

/** Strips a stray ```html fence and any prose the model wrapped around it. */
function cleanBody(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  s = s.replace(/^<!doctype[^>]*>/i, '')
       .replace(/<\/?(html|head|body)[^>]*>/gi, '')
       .replace(/<style[\s\S]*?<\/style>/gi, '')
       .replace(/<script[\s\S]*?<\/script>/gi, '')
       .trim();
  return s;
}

/**
 * Runs `jobs` with a bounded pool, in order, reporting each one separately.
 * @param jobs [{ key, label, prompt }]
 * @returns Map<key, {ok, body, error}>
 */
export async function runWorkers(jobs, { settings, signal, workers = DEFAULT_WORKERS,
                                         onStep, onUsage, system }) {
  const results = new Map();
  const queue = [...jobs];
  const width = Math.max(1, Math.min(8, workers));

  const one = async (job) => {
    const id = `sub:${job.key}`;
    onStep?.({ id, kind:'sub', running:true, label:job.label });
    try {
      let out = '';
      for await (const ev of stream({
        settings,
        messages: [{ role:'system', content: system }, { role:'user', content: job.prompt }],
        signal,
      })) {
        if (ev.t === 'text') out += ev.v;
        if (ev.t === 'usage') onUsage?.(ev.v);
      }
      const body = cleanBody(out);
      if (body.length < 60) throw new Error('came back empty');
      results.set(job.key, { ok:true, body });
      onStep?.({ id, kind:'sub', ok:true, label:`${job.label} — ${Math.round(body.length / 100) / 10}k` });
    } catch (e) {
      results.set(job.key, { ok:false, error: e.message });
      onStep?.({ id, kind:'sub', ok:false, label:`${job.label} — failed` });
    }
  };

  const lanes = Array.from({ length: width }, async () => {
    while (queue.length && !signal?.aborted) await one(queue.shift());
  });
  await Promise.all(lanes);
  return results;
}

/* ------------------------------------------------------------- briefings */

export const LESSON_SYSTEM = `You write one lesson of a course, and nothing else.

Return ONLY the lesson body as HTML. No <html>, <head>, <style> or <script>, no markdown fences, no preamble, no sign-off. The player supplies all styling.

400-900 words. Teach rather than list: concrete examples, real numbers, worked cases. Open with what the learner will be able to do by the end and close with a short recap. Include at least one interactive block, more in a practice lesson. Do not repeat what neighbouring lessons cover.`;

export const CHAPTER_SYSTEM = `You write one chapter of a book, and nothing else.

Return ONLY the chapter body as HTML. No <html>, <head>, <style> or <script>, no markdown fences, no preamble, no sign-off. The reader supplies all styling.

800-2000 words of real prose. Paragraphs, not bullet points — use a list only where a list is the honest form. Open in the middle of something concrete. Sub-headings (h2) every few hundred words. Do not summarise the chapters around you.`;

/** The shared markup vocabulary, kept identical to the one the agent is given. */
export const BLOCKS = `Markup you may use (already styled):
<div class="key"><b>Key idea</b><p>…</p></div>
<div class="tip"><b>Tip</b><p>…</p></div>
<div class="warn"><b>Careful</b><p>…</p></div>
<div class="q" data-a="1"><p>Question?</p><ul><li>A</li><li>B</li><li>C</li></ul><p class="why">Why B.</p></div>
<div class="fill" data-a="went">Yesterday I ___ home.</div>
<div class="card"><div class="front">word</div><div class="back">meaning</div></div>
Also h2, h3, p, ul, ol, table, blockquote, pre/code.`;

/** A slice of the uploaded document, proportional to where this item sits. */
export function sourceSlice(source, index, total, budget = 9000) {
  if (!source?.text) return '';
  const text = source.text;
  const span = Math.ceil(text.length / Math.max(1, total));
  const from = Math.min(text.length, index * span);
  const body = text.slice(from, from + Math.min(span + 1200, budget));
  if (!body.trim()) return '';
  return `\n\nSOURCE MATERIAL (from "${source.title}", the part covering this section — build on it, do not quote it wholesale):\n${body}`;
}
