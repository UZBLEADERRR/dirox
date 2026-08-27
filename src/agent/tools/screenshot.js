/**
 * Looking at the page, rather than at the markup that produced it.
 *
 * `inspect_page` already reads what a dev server returns, and that answers a
 * different question. Markup does not tell you that the attach button is two
 * pixels wide, that a `max-width: 900px` block placed after a `640px` block is
 * silently undoing it, that the page scrolls sideways on a phone, or that one
 * console error explains why nothing rendered at all. Those are found by
 * looking, and a person asked to trust a change they cannot see is being asked
 * to take it on faith.
 *
 * So the screenshot goes to the user — they can see it, which is most of the
 * point — and a measured report goes to the model. The model cannot see the
 * image: vision is not wired through the provider adapters yet, and pretending
 * otherwise would be worse than saying so. What it gets instead is the part of
 * looking that can be measured, which is closer to how anybody actually debugs
 * a layout: the console errors, whether the page scrolls sideways and which
 * elements cause it, controls too small to tap, the headings, the visible text.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { capturePage, browserAvailable } from '../../exec/browser.js';
import { writeWorkspaceBinary } from '../../exec/workspace.js';
import { previewFor } from '../../exec/preview.js';
import { deliverTools } from './deliver.js';

/** Named sizes, so the agent does not have to remember what a phone is. */
export const VIEWPORTS = {
  phone: { width: 390, height: 844, mobile: true, deviceScaleFactor: 2 },
  tablet: { width: 834, height: 1112, mobile: true, deviceScaleFactor: 2 },
  desktop: { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 },
  wide: { width: 1728, height: 1080, mobile: false, deviceScaleFactor: 1 }
};

/** Where screenshots live in the workspace. Inside the project, out of the way. */
const DIRECTORY = '.dirox/screenshots';

function fileName(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = String(label || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${DIRECTORY}/${slug || 'page'}-${stamp}.png`;
}

/**
 * Resolve what the agent asked to look at.
 *
 * A relative path means the project's own dev server, which is the common
 * case and the one worth making short: `/settings` rather than the loopback
 * address and port the preview happens to have been given.
 */
function resolveTarget(target, projectId) {
  const text = String(target || '/').trim();
  if (/^https?:\/\//i.test(text)) return text;

  const preview = projectId ? previewFor(projectId) : null;
  if (!preview || preview.status !== 'ready') {
    throw badRequest(
      `"${text}" is a path, so it needs the project's dev server running. Start it with open_preview first, or pass a full https:// URL.`
    );
  }
  return `${preview.url}${text.startsWith('/') ? text : `/${text}`}`;
}

/** The report the model reads, in the order the answers matter. */
function describe(report, { path, viewport }) {
  const device = report.device ?? report.viewport;
  const lines = [`Photographed ${report.url} on a ${viewport} (${device.width}×${device.height}).`];

  /*
     The layout viewport and the device are not the same number, and the gap
     between them is a real finding rather than a reporting quirk: a page with
     no `<meta name="viewport">` is laid out at 980px on a phone and scaled
     down, which is why most "it isn't responsive" reports are one missing tag.
  */
  if (device.mobile && report.hasViewportMeta === false) {
    lines.push(`It has no <meta name="viewport">, so a phone lays it out at ${report.viewport.width}px and scales it down. That is usually the whole bug.`);
  } else if (report.viewport.width !== device.width) {
    lines.push(`Laid out at ${report.viewport.width}px wide.`);
  }

  if (!report.loaded) lines.push('The page never fired its load event — something is still pending.');
  if (report.title) lines.push(`Title: ${report.title}`);

  if (report.problems?.length) {
    lines.push('', `${report.problems.length} console error(s):`);
    for (const problem of report.problems) lines.push(`  ${problem}`);
  } else {
    lines.push('Console: clean.');
  }

  if (report.scrollsSideways) {
    lines.push('', `The page scrolls sideways: content is ${report.scrollWidth}px wide in a ${report.viewport.width}px viewport.`);
    if (report.overflowing?.length) {
      lines.push('Caused by:');
      for (const element of report.overflowing) lines.push(`  ${element}`);
    }
  }

  if (report.tinyTargets?.length) {
    lines.push('', `Controls under 24px, which are hard to tap: ${report.tinyTargets.join(', ')}`);
  }

  if (report.headings?.length) lines.push('', `Headings: ${report.headings.join(' · ')}`);
  if (report.text) lines.push('', `Visible text: ${report.text.slice(0, 700)}`);

  lines.push('', `Saved to ${path}. The image has been sent to the user — you cannot see it, so describe what you changed rather than what it looks like.`);
  return lines.join('\n');
}

export const screenshotTools = [
  {
    name: 'screenshot_page',
    risk: RISK.SAFE,
    description:
      'Open a page in a real browser, photograph it, and report what is measurably wrong with it: console errors, sideways scroll and what causes it, controls too small to tap. ' +
      'The picture goes to the user; you get the measurements. Use a path like "/settings" for the project\'s own dev server, or a full https:// URL.',
    schema: t.object({
      target: t.string({ max: 2000, default: '/', description: 'A path on the running preview, or a full http(s) URL' }),
      viewport: t.enum(Object.keys(VIEWPORTS), { default: 'desktop' }),
      fullPage: t.boolean({ default: false, description: 'Capture the whole scrollable page rather than one screen' }),
      waitMs: t.integer({ min: 0, max: 10_000, default: 500, description: 'How long to wait after load, for anything that renders late' }),
      label: t.string({ max: 60, description: 'What this shot is of, used to name the file' })
    }),
    timeoutMs: 90_000,
    async run({ target, viewport, fullPage, waitMs, label }, ctx) {
      if (!await browserAvailable()) {
        return {
          ok: false,
          output: 'No browser is installed in this container, so pages cannot be photographed. '
            + 'inspect_page still reads the HTML. To enable screenshots, install Chromium and set CHROMIUM_PATH.'
        };
      }
      if (!ctx.projectId) throw badRequest('Screenshots are saved into a project workspace; open a project first.');

      const url = resolveTarget(target, ctx.projectId);
      const size = VIEWPORTS[viewport] ?? VIEWPORTS.desktop;

      const { png, report } = await capturePage(url, { ...size, fullPage, waitMs });

      const path = fileName(label || target);
      await writeWorkspaceBinary(ctx.projectId, path, png);

      // Reuse the delivery path rather than a second one: it holds the secret
      // check, the size limit and the row the download link is built from.
      const deliver = deliverTools.find(tool => tool.name === 'deliver_file');
      await deliver.run({ path, label: label || `Screenshot of ${target}` }, ctx).catch(() => null);

      return {
        output: describe(report, { path, viewport }),
        metadata: {
          path,
          url: report.url,
          viewport,
          problems: report.problems?.length ?? 0,
          scrollsSideways: Boolean(report.scrollsSideways)
        }
      };
    }
  }
];

export const SCREENSHOT_TOOL_NAMES = new Set(screenshotTools.map(tool => tool.name));
export { DIRECTORY, fileName, describe };
