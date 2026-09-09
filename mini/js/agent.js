/**
 * The turn loop.
 *
 * Two economies shape this file. First, the request window: only the last few
 * turns are sent, and a turn's tool traffic is thrown away once the turn ends —
 * the project files are the memory, and the agent can re-read them for the cost
 * of the one file it actually needs. Second, the system prompt: it carries a
 * one-line inventory of the project instead of the project.
 */

import { stream, LLMError } from './llm.js';
import { settingsFor } from './store.js';
import { toolsFor, runTool } from './tools.js';

const BLOCKS = `INTERACTIVE MARKUP (the player styles and wires these — do not write CSS or JS):
<div class="key"><b>Key idea</b><p>…</p></div>      callout
<div class="tip"><b>Tip</b><p>…</p></div>            green callout
<div class="warn"><b>Careful</b><p>…</p></div>       amber callout
<div class="q" data-a="1"><p>Question?</p><ul><li>A</li><li>B</li><li>C</li></ul><p class="why">Why B is right.</p></div>
    multiple choice; data-a is the 0-based index of the correct option
<div class="fill" data-a="went">Yesterday I ___ home.</div>   type-the-answer; ___ becomes the input
<div class="card"><div class="front">word</div><div class="back">meaning</div></div>   tap to flip
Also: h2, h3, p, ul, ol, table, blockquote, pre/code, <img src="rasm1.png">.`;

const APP_PROMPT = `You are the engineer inside "Mini". You build finished products that run on the user's phone — not demos.

PRODUCT STANDARD
- Never leave a TODO, a dead button or an empty screen. Whatever was asked for works end to end.
- Persist state in localStorage: reopening the app finds everything where it was.
- Empty, loading, error and confirmation states are all designed.
- Ask before destroying data. Offer undo where it is cheap.
- The layout survives the keyboard opening, and long lists stay fast.

DESIGN
- Mobile first: targets >=44px, no horizontal scroll, honour env(safe-area-inset-*), set the viewport meta.
- A real type scale (12/14/16/20/28), 4px spacing grid, 12-20px radii, soft shadows.
- One accent colour over a neutral ramp. Light and dark both look deliberate via prefers-color-scheme.
- Response on press (:active), transitions 120-200ms. No decorative animation.
- Contrast is sufficient; text never dissolves into its background.

TECHNIQUE
- Plain HTML/CSS/JS. No framework, no build step, NO external libraries — the app must be self-contained.
- Past ~300 lines, split into index.html + style.css + app.js.
- Small named functions, few globals. Never put user text through innerHTML; use textContent.
- For a camera, use <input type="file" accept="image/*" capture="environment"> — getUserMedia does not work in the sandbox.

ORDER OF WORK
1. Say in one sentence what you are building. No long plan.
2. write_file. 3. run_check. 4. Fix with edit_file and check again until it is clean.
5. screenshot only if the visual design needs judging. 6. publish_app. 7. Two sentences in the chat.

Write little. Do the work.`;

const COURSE_PROMPT = `You are a course designer and teacher inside "Mini". You build a complete, structured course that a person works through on their phone.

FIRST, UNDERSTAND
If the goal is vague, ask 3-5 short numbered questions in ONE message and stop: current level, exact target (band, exam, job, date), minutes per day, weakest areas, preferred language. If the user has already said enough, skip this and start.

THEN
1. course_outline — the whole syllabus first: 3-7 modules, 10-30 lessons in a sensible teaching order, each with an id, a title and realistic minutes. Build up: foundations, then technique, then practice, then a review or mock test.
2. write_lessons — hand the whole list to the parallel writers in ONE call. That is how a course gets built; do not write them one by one. If some come back failed, call it again with just those ids.
3. Spot-check with read_file, and fix anything weak with write_lesson.
4. run_check, then publish_app.

WHAT A LESSON IS
- 400-900 words. Teach; do not list. Concrete examples over description.
- Open with what the learner will be able to do, close with a short recap.
- At least one interactive block per lesson, more in practice lessons.
- Vary the shape: explanation, worked example, drill, practice test, common mistakes, review.
- Never repeat filler between lessons. Each one moves forward.
- Write the content in the user's language; keep technical terms in their usual form.

${BLOCKS}

The player, contents, progress, quiz behaviour and PDF export already exist. Write only lesson bodies.
Be brief in the chat: the course is the output, not the conversation.`;

const BOOK_PROMPT = `You are an author inside "Mini". You write a complete book that reads and prints like a real one.

FIRST, UNDERSTAND
If the brief is thin, ask 2-4 short numbered questions in ONE message and stop: who it is for, roughly how long, tone, and the one thing the reader should come away with. Otherwise start.

THEN
1. book_outline — title, author, subtitle, and 8-20 chapters that actually progress. No filler chapters.
2. write_chapters — hand the whole list to the parallel writers in ONE call. If some fail, call it again with just those ids.
3. set_cover — inline SVG, viewBox "0 0 400 600": typography, shapes and colour only. Make it look like a cover a publisher would print, not a diagram.
4. run_check, then publish_app.

WHAT A CHAPTER IS
- 800-2000 words of real prose. Paragraphs, not bullet points; use lists only where a list is the honest form.
- Open in the middle of something concrete. Examples, numbers, names, scenes.
- Sub-headings (h2) every few hundred words so the page breathes.
- A pull quote or a callout where it earns its place.
- Write in the user's language.

${BLOCKS}

The reader, contents, cover page, type controls and print layout already exist. Write only chapter bodies.
Be brief in the chat.`;

const PROMPTS = { app: APP_PROMPT, course: COURSE_PROMPT, book: BOOK_PROMPT };

function projectLine(project) {
  const bits = [];
  if (project.source) {
    const parts = Math.ceil(project.source.text.length / 12_000);
    bits.push(`Uploaded document: "${project.source.title}" (${parts} parts, read with read_source).`);
  }
  if (project.course) {
    const all = project.course.modules.flatMap(m => m.lessons);
    const done = all.filter(l => project.files[`lessons/${l.id}.html`]).length;
    bits.push(`Course "${project.course.title}": ${done}/${all.length} lessons written.`);
  } else if (project.book) {
    const done = project.book.chapters.filter(c => project.files[`chapters/${c.id}.html`]).length;
    bits.push(`Book "${project.book.title}": ${done}/${project.book.chapters.length} chapters written.`);
  } else {
    const files = Object.entries(project.files || {});
    bits.push(files.length
      ? `Project files: ${files.map(([k, v]) => `${k}(${Math.round(v.length / 100) / 10}k)`).join(' ')}`
      : 'The project is empty.');
  }
  const assets = (project.assets || []).map(a => a.name).join(', ');
  if (assets) bits.push(`Images available: ${assets}`);
  return bits.join('\n');
}

function systemPrompt(role, chat) {
  const parts = [];
  if (role.tools) parts.push(PROMPTS[role.kind] || APP_PROMPT);
  if (role.prompt) parts.push(role.prompt);
  if (!parts.length) parts.push('You are a helpful assistant. Answer briefly.');
  parts.push('Reply in whatever language the user writes in.');
  if (role.tools) parts.push(projectLine(chat.project));
  return parts.join('\n\n');
}

/**
 * What to show while a tool is running.
 *
 * The tools report what they did once they are done; this is the line that
 * stands there in the meantime, naming the actual file, lesson or chapter
 * rather than a generic "working…".
 */
function startLabel(name, a = {}) {
  switch (name) {
    case 'write_file':     return `Writing ${a.path || 'a file'}`;
    case 'edit_file':      return `Editing ${a.path || 'a file'}`;
    case 'delete_file':    return `Deleting ${a.path || 'a file'}`;
    case 'read_file':      return a.path ? `Reading ${a.path}` : 'Listing the files';
    case 'run_check':      return 'Running the app and watching for errors';
    case 'screenshot':     return 'Taking a screenshot';
    case 'publish_app':    return `Saving ${a.name || 'the app'}`;
    case 'course_outline': return 'Planning the syllabus';
    case 'write_lesson':   return `Writing the lesson “${a.id || ''}”`;
    case 'write_lessons':  return `Starting ${a.ids?.length || 'the'} writers on the lessons`;
    case 'write_chapters': return `Starting ${a.ids?.length || 'the'} writers on the chapters`;
    case 'book_outline':   return 'Planning the chapters';
    case 'write_chapter':  return `Writing the chapter “${a.id || ''}”`;
    case 'set_cover':      return 'Drawing the cover';
    case 'read_source':    return `Reading the document, part ${a.part || 1}`;
    case 'github_push':    return `Pushing to GitHub: ${a.repo || ''}`;
    default:               return name.replace(/_/g, ' ');
  }
}

/** Persisted history -> request messages. Images ride along only on user turns. */
function history(chat, limit) {
  const msgs = chat.messages.filter(m => m.role === 'user' || (m.role === 'assistant' && m.content));
  return msgs.slice(-limit).map(m => {
    if (m.role === 'user' && m.images?.length) {
      return { role:'user', content:[
        ...(m.content ? [{ type:'text', text:m.content }] : []),
        ...m.images.map(url => ({ type:'image_url', image_url:{ url } })),
      ]};
    }
    return { role:m.role, content:m.content };
  });
}

export class Agent {
  constructor(deps) { Object.assign(this, deps); }   // {settings, onDelta, onStep, onArtifact, publish, onUsage}

  stop() { this.controller?.abort(); }

  /**
   * Runs one user turn to completion: text, tool calls, retries, tool calls
   * again, until the model answers without asking for a tool.
   */
  async run(chat, role) {
    const s = settingsFor(role.model);      // a role may pin its own model
    this.settings = s;
    this.project = chat.project;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    const base = [
      { role:'system', content: systemPrompt(role, chat) },
      ...history(chat, s.historyLimit || 24),
    ];
    const scratch = [];                 // this turn's tool traffic; discarded after
    const tools = role.tools
      ? toolsFor(role.kind || 'app',
                 { hasSource: !!chat.project.source, github: !!s.githubToken })
      : null;
    let finalText = '';

    let spoke = false;
    for (let step = 0; step < (s.maxSteps || 14); step++) {
      let text = '', calls = null;
      if (spoke) this.onDelta?.('\n\n');

      for await (const ev of stream({
        settings: s, messages: [...base, ...scratch],
        tools, signal,
      })) {
        if (ev.t === 'text')  { text += ev.v; spoke = true; this.onDelta?.(ev.v); }
        if (ev.t === 'tools')  calls = ev.v;
        if (ev.t === 'usage')  this.onUsage?.(ev.v);
      }

      if (!calls?.length) { finalText = text || finalText; break; }
      if (step === (s.maxSteps || 26) - 1) {
        this.onStep?.({ kind:'limit', label:'Step limit reached — say “continue”', ok:false });
      }

      scratch.push({ role:'assistant', content: text || null, tool_calls: calls });

      const images = [];
      for (const [ci, c] of calls.entries()) {
        // Keyed by position as well as id: some providers reuse a call id
        // across steps, and two lessons must not collapse into one row.
        const stepKey = `${step}:${ci}:${c.id || ''}`;
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); }
        catch { scratch.push({ role:'tool', tool_call_id:c.id,
          content:'ERROR: arguments were not valid JSON. Send them again.' }); continue; }

        // One row per tool call, updated in place: it appears the moment the
        // call starts, says what is being touched, and settles when it lands.
        this.onStep?.({ id:stepKey, kind:c.function.name, running:true,
                        label: startLabel(c.function.name, args) });
        const scoped = { ...this, signal,
                         onStep: st => this.onStep?.({ id:stepKey, ...st }) };

        let out;
        try { out = await runTool(c.function.name, args, scoped); }
        catch (e) {
          out = { text:`ERROR: ${e.message}` };
          this.onStep?.({ id:stepKey, kind:c.function.name, ok:false,
                          label:`${startLabel(c.function.name, args)} — failed` });
        }

        scratch.push({ role:'tool', tool_call_id:c.id, content: out.text });
        if (out.image) images.push(out.image);
      }
      if (images.length) {
        scratch.push({ role:'user', content: images.map(url => ({ type:'image_url', image_url:{ url } })) });
      }
      // Never trimmed mid-turn: every tool result must stay paired with its
      // call or the next request is rejected. maxSteps is the real bound.
      if (signal.aborted) break;
    }

    return finalText.trim();
  }
}

export { LLMError };
