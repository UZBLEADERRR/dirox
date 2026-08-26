/**
 * Preview and inspection tools.
 *
 * These let the agent look at the running application instead of guessing what
 * the code renders. Page content is returned as data and labelled as such —
 * a rendered page is untrusted content like any other.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { startPreview, stopPreview, fetchPreview, previewStatus } from '../../exec/preview.js';
import { wrapUntrusted } from '../prompts.js';

/** Strip a page down to the structure that matters, at a fraction of the tokens. */
function summariseHtml(html) {
  const source = String(html);

  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(source)?.[1]?.trim();

  // Errors that frameworks render into the page are the most useful signal.
  const errors = [];
  for (const pattern of [
    /<pre[^>]*>([\s\S]{0,1200}?)<\/pre>/gi,
    /(?:Error|Exception|Failed to compile|Module not found)[^<\n]{0,300}/g
  ]) {
    for (const match of source.matchAll(pattern)) {
      const text = match[1] ?? match[0];
      const clean = text.replace(/<[^>]+>/g, '').trim();
      if (clean && !errors.includes(clean)) errors.push(clean.slice(0, 600));
      if (errors.length >= 5) break;
    }
  }

  const headings = [...source.matchAll(/<h([1-6])[^>]*>([\s\S]{0,200}?)<\/h\1>/gi)]
    .map(match => `${'#'.repeat(Number(match[1]))} ${match[2].replace(/<[^>]+>/g, '').trim()}`)
    .filter(line => line.length > 2)
    .slice(0, 25);

  const interactive = [...source.matchAll(/<(button|a|input|select|textarea)\b([^>]*)>([\s\S]{0,80}?)<\/\1>|<(input|img)\b([^>]*)\/?>/gi)]
    .map(match => {
      const tag = match[1] || match[4];
      const attributes = match[2] || match[5] || '';
      const label = (match[3] || '').replace(/<[^>]+>/g, '').trim();
      const id = /\bid=["']([^"']+)/.exec(attributes)?.[1];
      const name = /\bname=["']([^"']+)/.exec(attributes)?.[1];
      const type = /\btype=["']([^"']+)/.exec(attributes)?.[1];
      const alt = /\balt=["']([^"']*)/.exec(attributes)?.[1];
      const descriptor = [label, alt, name && `name=${name}`, id && `#${id}`, type && `type=${type}`].filter(Boolean).join(' ');
      return descriptor ? `<${tag}> ${descriptor}` : null;
    })
    .filter(Boolean)
    .slice(0, 40);

  const text = source
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2500);

  return { title, errors, headings, interactive, text, bytes: source.length };
}

export const previewTools = [
  {
    name: 'open_preview',
    risk: RISK.WRITE,
    description:
      'Start the project dev server and return its status. Use this before inspecting pages. ' +
      'The server is sandboxed and bound to localhost only.',
    schema: t.object({
      timeoutSeconds: t.integer({ min: 10, max: 180, default: 90 })
    }),
    async run({ timeoutSeconds }, ctx) {
      const command = ctx.project?.dev_command;
      if (!command) {
        throw badRequest('This project has no dev command configured. Set one in project settings first.');
      }
      const result = await startPreview(ctx.projectId, { command, timeoutMs: timeoutSeconds * 1000 });
      return {
        output: `Dev server is running at ${result.url} (started with \`${command}\`).`,
        metadata: { url: result.url, port: result.port, status: result.status }
      };
    }
  },

  {
    name: 'inspect_page',
    risk: RISK.SAFE,
    description:
      'Fetch a page from the running preview and return its structure: title, headings, interactive elements, ' +
      'visible text and any rendered errors. Far cheaper than reading raw HTML.',
    schema: t.object({
      path: t.string({ max: 300, default: '/', description: 'Path to open, e.g. /login' }),
      raw: t.boolean({ default: false, description: 'Return the raw HTML instead of a summary. Expensive — avoid unless necessary.' })
    }),
    async run({ path, raw }, ctx) {
      const page = await fetchPreview(ctx.projectId, path);

      if (raw || !page.contentType.includes('html')) {
        return {
          ok: page.status < 400,
          output: wrapUntrusted(page.body.slice(0, 30_000), `preview:${path}`),
          metadata: { status: page.status, contentType: page.contentType }
        };
      }

      const summary = summariseHtml(page.body);
      const lines = [
        `${page.url} → HTTP ${page.status}`,
        summary.title ? `Title: ${summary.title}` : null,
        summary.errors.length ? `\nErrors rendered on the page:\n${summary.errors.map(error => `  ${error}`).join('\n')}` : null,
        summary.headings.length ? `\nHeadings:\n${summary.headings.join('\n')}` : null,
        summary.interactive.length ? `\nInteractive elements:\n${summary.interactive.join('\n')}` : null,
        summary.text ? `\nVisible text:\n${summary.text}` : null
      ].filter(Boolean).join('\n');

      return {
        ok: page.status < 400,
        output: wrapUntrusted(lines, `preview:${path}`),
        metadata: {
          status: page.status,
          hasErrors: summary.errors.length > 0,
          headings: summary.headings.length,
          bytes: summary.bytes
        }
      };
    }
  },

  {
    name: 'preview_status',
    risk: RISK.SAFE,
    description: 'Check whether the preview server is running, and read its recent output.',
    schema: t.object({}),
    async run(_args, ctx) {
      const status = previewStatus(ctx.projectId);
      if (!status.running) return { output: 'No preview server is running for this project.', metadata: status };
      return {
        output: `Preview is ${status.status} at ${status.url}.\n\nRecent output:\n${status.log.slice(-3000)}`,
        metadata: { status: status.status, url: status.url }
      };
    }
  },

  {
    name: 'close_preview',
    risk: RISK.WRITE,
    description: 'Stop the preview server when you are finished with it.',
    schema: t.object({}),
    async run(_args, ctx) {
      const stopped = await stopPreview(ctx.projectId);
      return { output: stopped ? 'Preview server stopped.' : 'No preview server was running.', metadata: { stopped } };
    }
  }
];

export { summariseHtml };
