/**
 * The agent's hands.
 *
 * Deliberately few, and split by what is being made: an app builder never sees
 * the chapter tools, a book writer never sees `edit_file`. Every tool schema is
 * text in every request of a run, and a run can be forty steps long.
 *
 * Courses and books do not write their own player — see templates.js. The tools
 * here take an outline and one body at a time, and rebuild the finished app
 * around them after each write, so the thing is openable from the first lesson.
 */

import { runCheck, formatCheck } from './sandbox.js';
import { buildCourse, buildBook } from './templates.js';
import { runWorkers, sourceSlice, LESSON_SYSTEM, CHAPTER_SYSTEM, BLOCKS } from './subagent.js';
import { t } from './i18n.js';

/* ---------------------------------------------------------------- schemas */

const fileTools = [
  { name:'write_file',
    description:'Create or replace a file. Use edit_file for small changes.',
    params:{ path:{ type:'string', description:'index.html, style.css, app.js' },
             content:{ type:'string' } }, required:['path','content'] },
  { name:'edit_file',
    description:'Replace one exact passage inside a file. `find` must occur exactly once.',
    params:{ path:{ type:'string' }, find:{ type:'string' }, replace:{ type:'string' } },
    required:['path','find','replace'] },
  { name:'delete_file',
    description:'Delete a file that is no longer needed.',
    params:{ path:{ type:'string' } }, required:['path'] },
];

const readTool = {
  name:'read_file',
  description:'Read a file. With no path, lists the files in the project.',
  params:{ path:{ type:'string' } }, required:[] };

const checkTools = [
  { name:'run_check',
    description:'Run the project in a browser and report errors, clicked controls and layout problems. Call after every change.',
    params:{}, required:[] },
  { name:'screenshot',
    description:'Render the project and look at it. Only when the visual design needs judging — images cost tokens.',
    params:{}, required:[] },
];

const publishTool = {
  name:'publish_app',
  description:'Put the finished thing on the user\'s home screen. Call once, at the end.',
  params:{ name:{ type:'string', description:'Short name, 1-3 words' },
           emoji:{ type:'string', description:'A single emoji' },
           color:{ type:'string', description:'#RRGGBB background' } },
  required:['name','emoji'] };

const sourceTool = {
  name:'read_source',
  description:'Read the document the user uploaded, one part at a time. Part 1 is the beginning.',
  params:{ part:{ type:'integer', description:'1-based part number' } }, required:['part'] };

const courseTools = [
  { name:'course_outline',
    description:'Define the whole course before writing any lesson. The player, progress tracking and layout are generated from this.',
    params:{
      title:{ type:'string' },
      subtitle:{ type:'string', description:'One line: who it is for and what they will be able to do' },
      language:{ type:'string', description:'Language code the content is written in, e.g. en, uz, ru' },
      accent:{ type:'string', description:'#RRGGBB accent colour' },
      modules:{ type:'array', description:'Modules in order',
        items:{ type:'object', properties:{
          title:{ type:'string' },
          lessons:{ type:'array', items:{ type:'object', properties:{
            id:{ type:'string', description:'short slug, unique, e.g. l1, listening-map' },
            title:{ type:'string' },
            minutes:{ type:'integer' } }, required:['id','title'] } } },
          required:['title','lessons'] } } },
    required:['title','modules'] },
  { name:'write_lessons',
    description:'Write several lessons at once — they are handed to parallel writers, which is how the bulk of a course should be produced. Omit ids to write every lesson that is still missing.',
    params:{ ids:{ type:'array', items:{ type:'string' },
      description:'Lesson ids. Leave empty for all unwritten lessons.' } },
    required:[] },
  { name:'write_lesson',
    description:'Write or rewrite ONE lesson yourself. Use this to fix a lesson, not to produce the course.',
    params:{ id:{ type:'string' },
             html:{ type:'string', description:'Lesson body HTML' } },
    required:['id','html'] },
];

const bookTools = [
  { name:'book_outline',
    description:'Define the whole book before writing any chapter. The reader, contents and print layout are generated from this.',
    params:{
      title:{ type:'string' }, author:{ type:'string' },
      subtitle:{ type:'string' },
      language:{ type:'string', description:'Language code, e.g. en, uz, ru' },
      accent:{ type:'string', description:'#RRGGBB accent colour' },
      chapters:{ type:'array', items:{ type:'object', properties:{
        id:{ type:'string', description:'short slug, unique' },
        title:{ type:'string' } }, required:['id','title'] } } },
    required:['title','chapters'] },
  { name:'write_chapters',
    description:'Write several chapters at once — they are handed to parallel writers, which is how the bulk of a book should be produced. Omit ids to write every chapter that is still missing.',
    params:{ ids:{ type:'array', items:{ type:'string' } } }, required:[] },
  { name:'write_chapter',
    description:'Write or rewrite ONE chapter yourself. Use this to fix a chapter, not to produce the book.',
    params:{ id:{ type:'string' }, html:{ type:'string' } }, required:['id','html'] },
  { name:'set_cover',
    description:'Set the book cover as inline SVG, 400x600 viewBox. Typography and shapes only; no external images.',
    params:{ svg:{ type:'string' } }, required:['svg'] },
];

const spec = (t) => ({
  type:'function',
  function:{
    name: t.name,
    description: t.description,
    parameters: { type:'object', properties: t.params, required: t.required || [] },
  },
});

/** Only the tools the current job needs — schemas are paid for on every step. */
export function toolsFor(kind, { hasSource = false } = {}) {
  const base =
    kind === 'course' ? [...courseTools, readTool, ...checkTools, publishTool]
  : kind === 'book'   ? [...bookTools, readTool, checkTools[0], publishTool]
  :                     [...fileTools, readTool, ...checkTools, publishTool];
  return [...(hasSource ? [sourceTool] : []), ...base].map(spec);
}

/* -------------------------------------------------------------- executing */

const MAX_RESULT = 6000;
const SOURCE_PART = 12_000;
const clip = s => (s.length > MAX_RESULT
  ? s.slice(0, MAX_RESULT) + `\n…(truncated from ${s.length} characters)` : s);

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 32);

/** Regenerates index.html from the outline and the bodies written so far. */
function rebuild(p) {
  if (p.course) {
    const lessons = {};
    for (const [path, body] of Object.entries(p.files)) {
      const m = path.match(/^lessons\/(.+)\.html$/);
      if (m) lessons[m[1]] = body;
    }
    p.files['index.html'] = buildCourse(p.course, lessons);
  } else if (p.book) {
    const chapters = {};
    for (const [path, body] of Object.entries(p.files)) {
      const m = path.match(/^chapters\/(.+)\.html$/);
      if (m) chapters[m[1]] = body;
    }
    p.files['index.html'] = buildBook({ ...p.book, coverSvg: p.files['cover.svg'] }, chapters);
  }
}

/**
 * @param ctx {{ project, onStep, onArtifact, publish }}
 * @returns {{text:string, image?:string}}
 */
export async function runTool(name, args, ctx) {
  const p = ctx.project;
  p.files ||= {}; p.assets ||= [];

  switch (name) {

    /* ---------------------------------------------------------- files */

    case 'write_file': {
      const path = (args.path || 'index.html').replace(/^\.?\//, '');
      p.files[path] = String(args.content ?? '');
      ctx.onStep?.({ kind:'write', label:`${t('steps.write')}: ${path}`, ok:true });
      ctx.onArtifact?.();
      return { text:`OK ${path} (${p.files[path].length} chars)` };
    }

    case 'edit_file': {
      const path = (args.path || '').replace(/^\.?\//, '');
      const src = p.files[path];
      if (src == null) return { text:`ERROR: no such file ${path}. Have: ${Object.keys(p.files).join(', ') || '—'}` };
      const find = String(args.find ?? '');
      const n = find ? src.split(find).length - 1 : 0;
      if (n === 0) return { text:`ERROR: "find" does not occur in ${path}. Read the file first.` };
      if (n > 1)  return { text:`ERROR: "find" occurs ${n} times. Give a longer, unique passage.` };
      p.files[path] = src.replace(find, String(args.replace ?? ''));
      if (/^(lessons|chapters)\//.test(path)) rebuild(p);
      ctx.onStep?.({ kind:'edit', label:`${t('steps.edit')}: ${path}`, ok:true });
      ctx.onArtifact?.();
      return { text:`OK patched ${path}` };
    }

    case 'delete_file': {
      const path = (args.path || '').replace(/^\.?\//, '');
      if (path === 'index.html') return { text:'ERROR: index.html cannot be deleted.' };
      if (p.files[path] == null) return { text:`ERROR: no such file ${path}.` };
      delete p.files[path];
      rebuild(p);
      ctx.onStep?.({ kind:'edit', label:`Deleted: ${path}`, ok:true });
      ctx.onArtifact?.();
      return { text:`OK deleted ${path}` };
    }

    case 'read_file': {
      const path = (args.path || '').replace(/^\.?\//, '');
      if (!path) {
        const list = Object.entries(p.files).map(([k, v]) => `${k} (${v.length}b)`).join('\n') || '(empty)';
        const assets = p.assets.map(a => a.name).join(', ');
        ctx.onStep?.({ kind:'list', label:t('steps.list'), ok:true });
        return { text:`Files:\n${list}${assets ? `\nImages: ${assets}` : ''}` };
      }
      if (p.files[path] == null) return { text:`ERROR: no such file ${path}.` };
      ctx.onStep?.({ kind:'read', label:`${t('steps.read')}: ${path}`, ok:true });
      return { text: clip(p.files[path]) };
    }

    /* --------------------------------------------------------- course */

    case 'course_outline': {
      const modules = (args.modules || []).map(m => ({
        title: String(m.title || 'Module'),
        lessons: (m.lessons || []).map((l, i) => ({
          id: slug(l.id) || `l${i + 1}`,
          title: String(l.title || 'Lesson'),
          minutes: Number(l.minutes) || 0,
        })),
      })).filter(m => m.lessons.length);

      const count = modules.reduce((n, m) => n + m.lessons.length, 0);
      if (!count) return { text:'ERROR: the outline has no lessons.' };

      p.course = {
        title: String(args.title || 'Course').slice(0, 90),
        subtitle: String(args.subtitle || '').slice(0, 200),
        language: String(args.language || 'en').slice(0, 8),
        accent: args.accent, modules,
      };
      delete p.book;
      rebuild(p);
      ctx.onStep?.({ kind:'outline', label:`${t('steps.outline')}: ${modules.length} modules, ${count} lessons`, ok:true });
      ctx.onArtifact?.();
      const ids = modules.flatMap(m => m.lessons.map(l => l.id));
      return { text:`OK outline saved. Write each lesson with write_lesson.\nLesson ids in order: ${ids.join(', ')}` };
    }

    case 'write_lesson': {
      if (!p.course) return { text:'ERROR: call course_outline first.' };
      const id = slug(args.id);
      const all = p.course.modules.flatMap(m => m.lessons);
      const lesson = all.find(l => l.id === id);
      if (!lesson) return { text:`ERROR: "${id}" is not in the outline. Ids: ${all.map(l => l.id).join(', ')}` };
      p.files[`lessons/${id}.html`] = String(args.html ?? '');
      rebuild(p);
      const written = all.filter(l => p.files[`lessons/${l.id}.html`]).length;
      ctx.onStep?.({ kind:'lesson', label:`${t('steps.lesson')} ${written}/${all.length}: ${lesson.title}`, ok:true });
      ctx.onArtifact?.();
      const next = all.find(l => !p.files[`lessons/${l.id}.html`]);
      return { text: next
        ? `OK ${written}/${all.length}. Next id: ${next.id} — "${next.title}"`
        : `OK all ${all.length} lessons written. Run run_check, then publish_app.` };
    }

    case 'write_lessons': {
      if (!p.course) return { text:'ERROR: call course_outline first.' };
      const all = p.course.modules.flatMap(m => m.lessons.map(l => ({ ...l, module:m.title })));
      const want = (Array.isArray(args.ids) && args.ids.length)
        ? args.ids.map(slug).filter(id => all.some(l => l.id === id))
        : all.filter(l => !p.files[`lessons/${l.id}.html`]).map(l => l.id);
      if (!want.length) return { text:'Every lesson is already written.' };

      const jobs = want.map(id => {
        const i = all.findIndex(l => l.id === id);
        const l = all[i];
        const near = (from, to) => all.slice(Math.max(0, from), to).map(x => x.title).join('; ') || '—';
        return { key:id, label:`Lesson ${i + 1}/${all.length}: ${l.title}`, prompt:
`COURSE: ${p.course.title}${p.course.subtitle ? ` — ${p.course.subtitle}` : ''}
LANGUAGE: write everything in ${p.course.language || 'en'}
MODULE: ${l.module}
THIS LESSON: ${l.title}${l.minutes ? ` (${l.minutes} minutes)` : ''} — number ${i + 1} of ${all.length}
COMES AFTER: ${near(i - 2, i)}
COMES BEFORE: ${near(i + 1, i + 3)}

${BLOCKS}${sourceSlice(p.source, i, all.length)}` };
      });

      const res = await runWorkers(jobs, {
        settings: ctx.settings, signal: ctx.signal, workers: ctx.settings?.workers,
        onStep: ctx.onStep, onUsage: ctx.onUsage, system: LESSON_SYSTEM,
      });

      let wrote = 0;
      const failed = [];
      for (const [id, r] of res) {
        if (r.ok) { p.files[`lessons/${id}.html`] = r.body; wrote++; }
        else failed.push(`${id} (${r.error})`);
      }
      rebuild(p);
      ctx.onArtifact?.();
      // Settle this call's own row, which has been sitting open while the
      // writers worked underneath it.
      ctx.onStep?.({ kind:'lesson', ok: !failed.length,
                     label:`Wrote ${wrote} of ${want.length} lessons` });
      const left = all.filter(l => !p.files[`lessons/${l.id}.html`]).map(l => l.id);
      return { text:`Wrote ${wrote} of ${want.length} lessons.` +
        (failed.length ? `\nFailed: ${failed.join(', ')} — retry with write_lessons.` : '') +
        (left.length ? `\nStill missing: ${left.join(', ')}` : '\nAll lessons are written. Run run_check, then publish_app.') };
    }

    /* ----------------------------------------------------------- book */

    case 'book_outline': {
      const chapters = (args.chapters || []).map((c, i) => ({
        id: slug(c.id) || `ch${i + 1}`,
        title: String(c.title || `Chapter ${i + 1}`),
      }));
      if (!chapters.length) return { text:'ERROR: the outline has no chapters.' };

      p.book = {
        title: String(args.title || 'Book').slice(0, 90),
        author: String(args.author || '').slice(0, 60),
        subtitle: String(args.subtitle || '').slice(0, 200),
        language: String(args.language || 'en').slice(0, 8),
        accent: args.accent, chapters,
      };
      delete p.course;
      rebuild(p);
      ctx.onStep?.({ kind:'outline', label:`${t('steps.outline')}: ${chapters.length} chapters`, ok:true });
      ctx.onArtifact?.();
      return { text:`OK outline saved. Chapter ids in order: ${chapters.map(c => c.id).join(', ')}` };
    }

    case 'write_chapter': {
      if (!p.book) return { text:'ERROR: call book_outline first.' };
      const id = slug(args.id);
      const ch = p.book.chapters.find(c => c.id === id);
      if (!ch) return { text:`ERROR: "${id}" is not in the outline. Ids: ${p.book.chapters.map(c => c.id).join(', ')}` };
      p.files[`chapters/${id}.html`] = String(args.html ?? '');
      rebuild(p);
      const written = p.book.chapters.filter(c => p.files[`chapters/${c.id}.html`]).length;
      ctx.onStep?.({ kind:'chapter', label:`${t('steps.chapter')} ${written}/${p.book.chapters.length}: ${ch.title}`, ok:true });
      ctx.onArtifact?.();
      const next = p.book.chapters.find(c => !p.files[`chapters/${c.id}.html`]);
      return { text: next
        ? `OK ${written}/${p.book.chapters.length}. Next id: ${next.id} — "${next.title}"`
        : `OK all chapters written. Add set_cover if you have not, then publish_app.` };
    }

    case 'write_chapters': {
      if (!p.book) return { text:'ERROR: call book_outline first.' };
      const all = p.book.chapters;
      const want = (Array.isArray(args.ids) && args.ids.length)
        ? args.ids.map(slug).filter(id => all.some(c => c.id === id))
        : all.filter(c => !p.files[`chapters/${c.id}.html`]).map(c => c.id);
      if (!want.length) return { text:'Every chapter is already written.' };

      const jobs = want.map(id => {
        const i = all.findIndex(c => c.id === id);
        const c = all[i];
        const near = (from, to) => all.slice(Math.max(0, from), to).map(x => x.title).join('; ') || '—';
        return { key:id, label:`Chapter ${i + 1}/${all.length}: ${c.title}`, prompt:
`BOOK: ${p.book.title}${p.book.subtitle ? ` — ${p.book.subtitle}` : ''}
AUTHOR: ${p.book.author || 'the author'}
LANGUAGE: write everything in ${p.book.language || 'en'}
THIS CHAPTER: ${c.title} — number ${i + 1} of ${all.length}
COMES AFTER: ${near(i - 2, i)}
COMES BEFORE: ${near(i + 1, i + 3)}

${BLOCKS}${sourceSlice(p.source, i, all.length)}` };
      });

      const res = await runWorkers(jobs, {
        settings: ctx.settings, signal: ctx.signal, workers: ctx.settings?.workers,
        onStep: ctx.onStep, onUsage: ctx.onUsage, system: CHAPTER_SYSTEM,
      });

      let wrote = 0;
      const failed = [];
      for (const [id, r] of res) {
        if (r.ok) { p.files[`chapters/${id}.html`] = r.body; wrote++; }
        else failed.push(`${id} (${r.error})`);
      }
      rebuild(p);
      ctx.onArtifact?.();
      ctx.onStep?.({ kind:'chapter', ok: !failed.length,
                     label:`Wrote ${wrote} of ${want.length} chapters` });
      const left = all.filter(c => !p.files[`chapters/${c.id}.html`]).map(c => c.id);
      return { text:`Wrote ${wrote} of ${want.length} chapters.` +
        (failed.length ? `\nFailed: ${failed.join(', ')} — retry with write_chapters.` : '') +
        (left.length ? `\nStill missing: ${left.join(', ')}` : '\nAll chapters are written. Add set_cover, then run_check and publish_app.') };
    }

    case 'set_cover': {
      const svg = String(args.svg || '');
      if (!/^\s*<svg[\s>]/i.test(svg)) return { text:'ERROR: the cover must start with <svg.' };
      if (/<(script|foreignObject|image)\b/i.test(svg))
        return { text:'ERROR: no script, foreignObject or external images in the cover.' };
      p.files['cover.svg'] = svg;
      rebuild(p);
      ctx.onStep?.({ kind:'cover', label:t('steps.cover'), ok:true });
      ctx.onArtifact?.();
      return { text:'OK cover set.' };
    }

    /* --------------------------------------------------------- source */

    case 'read_source': {
      const src = p.source;
      if (!src) return { text:'ERROR: no document was uploaded.' };
      const parts = Math.ceil(src.text.length / SOURCE_PART);
      const n = Math.min(Math.max(1, Number(args.part) || 1), parts);
      const body = src.text.slice((n - 1) * SOURCE_PART, n * SOURCE_PART);
      ctx.onStep?.({ kind:'source', label:`${t('steps.source')} ${n}/${parts}`, ok:true });
      return { text:`"${src.title}" — part ${n} of ${parts}\n\n${body}` };
    }

    /* ---------------------------------------------------- check & ship */

    case 'run_check': {
      if (!p.files['index.html']) return { text:'ERROR: nothing to run yet.' };
      ctx.onStep?.({ kind:'check', label:t('steps.check'), running:true });
      const r = await runCheck(p, { interact:true });
      const bad = r.fatal || r.blank || (r.errors || []).length || (r.clickErrors || []).length;
      ctx.onStep?.({ kind:'check', label:t('steps.check'), ok:!bad, replace:true });
      return { text: formatCheck(r) };
    }

    case 'screenshot': {
      if (!p.files['index.html']) return { text:'ERROR: nothing to render yet.' };
      ctx.onStep?.({ kind:'shot', label:t('steps.shot'), running:true });
      const r = await runCheck(p, { interact:false, shot:true });
      ctx.onStep?.({ kind:'shot', label:t('steps.shot'), ok:!!r.shot, replace:true });
      if (!r.shot) return { text:`Screenshot failed (${r.shotError || 'unsupported'}). Use run_check instead.` };
      return { text:'Screenshot:', image:r.shot };
    }

    case 'publish_app': {
      if (!p.files['index.html']) return { text:'ERROR: nothing to publish yet.' };
      const app = ctx.publish({
        name: String(args.name || p.course?.title || p.book?.title || 'Mini app').slice(0, 24),
        emoji: (args.emoji || (p.course ? '🎓' : p.book ? '📖' : '📱')).slice(0, 4),
        color: /^#[0-9a-f]{6}$/i.test(args.color || '') ? args.color : null,
      });
      ctx.onStep?.({ kind:'publish', label:`${t('steps.publish')}: ${app.name}`, ok:true });
      return { text:`OK "${app.name}" is on the user's home screen. Now answer briefly.` };
    }

    default:
      return { text:`ERROR: no tool named "${name}".` };
  }
}
