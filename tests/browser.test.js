/**
 * Looking at a page, in a real browser.
 *
 * These run against Chromium when the container has one and skip when it does
 * not, because a missing browser is a deployment fact rather than a failure —
 * and a suite that goes red on a machine without Chrome teaches people to
 * ignore it.
 *
 * What is being tested is not "a PNG came back". It is that the report is
 * worth acting on: that a console error reaches the agent, that a genuine
 * layout overflow is reported and a deliberately hidden drawer is not, and
 * that a control too small to tap is named.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

const { findBrowser, capturePage } = await import('../src/exec/browser.js');
const { describe: describeReport, VIEWPORTS } = await import('../src/agent/tools/screenshot.js');

const available = Boolean(await findBrowser());

/** A page with the three problems a person would notice by looking. */
const BROKEN = `<!doctype html><html><head>
  <title>Broken</title>
  <style>
    body { margin: 0 }
    .wide { width: 1400px; height: 40px; background: #333 }
    .drawer { position: fixed; left: -300px; width: 280px; height: 100%; background: #111 }
    .tiny { width: 12px; height: 12px; padding: 0 }
  </style>
</head><body>
  <div class="drawer" id="menu">off-screen by design</div>
  <h1>Broken</h1>
  <div class="wide" id="overflowing">too wide</div>
  <button class="tiny" id="close">x</button>
  <script>console.error('the config failed to load'); missingFunction();</script>
</body></html>`;

/** A page with none of them. */
const FINE = `<!doctype html><html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fine</title>
  <style>body{margin:0} button{width:44px;height:44px}</style>
</head><body><h1>Fine</h1><button>ok</button></body></html>`;

let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/fine') ? FINE : BROKEN);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('a page comes back as a picture and a report', { skip: !available && 'no browser installed' }, async () => {
  const { png, report } = await capturePage(`${base}/fine`, { ...VIEWPORTS.desktop, waitMs: 200 });

  // A PNG, and actually a PNG: the first eight bytes are the signature.
  assert.ok(png.length > 1000, `the screenshot was ${png.length} bytes`);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  assert.equal(report.title, 'Fine');
  assert.equal(report.loaded, true);
  assert.deepEqual(report.problems, []);
  assert.equal(report.scrollsSideways, false);
  assert.deepEqual(report.tinyTargets, []);
});

test('the console is read, which is often the whole answer', { skip: !available && 'no browser installed' }, async () => {
  const { report } = await capturePage(base, { ...VIEWPORTS.desktop, waitMs: 300 });

  const joined = report.problems.join('\n');
  assert.match(joined, /the config failed to load/, 'a console.error did not reach the agent');
  assert.match(joined, /missingFunction is not defined/, 'an uncaught exception did not reach the agent');
});

test('a real overflow is named, and a hidden drawer is not', { skip: !available && 'no browser installed' }, async () => {
  /*
     The false positive this guards against is specific and was real: a drawer
     parked at left:-300px is the standard mobile pattern, and reporting it as
     an overflow sends the agent to fix something that is not broken. Only a
     right-hand overhang causes the horizontal scroll anybody complains about.
  */
  const { report } = await capturePage(base, { ...VIEWPORTS.phone, waitMs: 300 });

  assert.equal(report.scrollsSideways, true, 'a 1400px block in a narrow viewport did not register');
  const named = report.overflowing.join(' ');
  assert.match(named, /#overflowing/, 'the element that causes the overflow was not named');
  assert.ok(!named.includes('#menu'), 'an off-screen drawer was reported as a layout bug');
});

test('a control too small to tap is named with its size', { skip: !available && 'no browser installed' }, async () => {
  const { report } = await capturePage(base, { ...VIEWPORTS.phone, waitMs: 300 });
  assert.match(report.tinyTargets.join(' '), /#close 12×12px/);
});

test('a missing viewport tag is reported as the bug it usually is', { skip: !available && 'no browser installed' }, async () => {
  const { report } = await capturePage(base, { ...VIEWPORTS.phone, waitMs: 200 });
  assert.equal(report.hasViewportMeta, false);

  const text = describeReport(report, { path: 'x.png', viewport: 'phone' });
  assert.match(text, /no <meta name="viewport">/);
  // The device asked for and the width the page chose are both stated.
  assert.match(text, /390×844/);
});

test('a page that is fine reads as fine', { skip: !available && 'no browser installed' }, async () => {
  const { report } = await capturePage(`${base}/fine`, { ...VIEWPORTS.phone, waitMs: 200 });
  const text = describeReport(report, { path: 'x.png', viewport: 'phone' });

  assert.match(text, /Console: clean/);
  assert.ok(!text.includes('scrolls sideways'));
  assert.ok(!text.includes('hard to tap'));
});

test('a URL that is not a URL is refused before a browser is started', { skip: !available && 'no browser installed' }, async () => {
  await assert.rejects(() => capturePage('/just/a/path'), /full http\(s\) URL/i);
});
