/**
 * Driving a real browser, with nothing installed to do it.
 *
 * The agent could already read the HTML a dev server returns. That is not the
 * same as seeing the page: it does not tell you the button is two pixels wide,
 * that a media query is undoing another one, that the layout scrolls sideways
 * on a phone, or that the console is full of the error which explains why
 * nothing renders. Those are the bugs a person finds by looking, and until now
 * the agent could only find them by being told.
 *
 * So this speaks the Chrome DevTools Protocol directly. Chrome exposes it over
 * a WebSocket, Node has had a WebSocket client built in since 21, and the
 * whole session is four commands. A library would add a dependency to this
 * project's zero, and would do the same four things.
 *
 * What comes back is deliberately two things at once:
 *
 *   a PNG        for the person. They can see it, which is the point.
 *   a report     for the model. It cannot see the PNG — vision is not wired
 *                through the provider adapters — so the parts of "looking"
 *                that can be measured are measured: console errors, sideways
 *                scroll, elements wider than the screen, the title. That is
 *                closer to how anybody actually debugs a layout than a
 *                description of a picture would be.
 *
 * If no browser is installed, everything here says so plainly and the run
 * continues. A missing binary is a deployment fact, not a crash.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { logger } from '../core/logger.js';
import { badRequest, notConfigured } from '../core/errors.js';

/** Where a Chrome tends to be, in the order worth trying. */
const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  process.env.CHROME_PATH,
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

/** Resolved once: the answer cannot change while the process runs. */
let cachedBinary;

export async function findBrowser() {
  if (cachedBinary !== undefined) return cachedBinary;

  for (const candidate of CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      cachedBinary = candidate;
      return cachedBinary;
    } catch { /* try the next one */ }
  }

  cachedBinary = null;
  return null;
}

/** For tests, and for a deployment that installs a browser after boot. */
export function resetBrowserCache() { cachedBinary = undefined; }

export async function browserAvailable() {
  return Boolean(await findBrowser());
}

/**
 * Start Chrome and wait for it to say where its protocol endpoint is.
 *
 * Port zero, and the real port read back from stderr: picking a number
 * ourselves means racing whatever else the container is running.
 */
async function launch(binary, { timeoutMs = 20_000 } = {}) {
  const child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    // The container runs as root and has no user namespace; without this
    // Chrome refuses to start at all.
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    // Nothing here should reach out on its own behalf.
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--metrics-recording-only'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('the browser did not start in time')), timeoutMs);

    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
      // Chrome is chatty on stderr; keeping it all would grow without bound.
      if (stderr.length > 32_000) stderr = stderr.slice(-8_000);
    });

    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`the browser exited with code ${code}`)); });
  }).catch(error => {
    child.kill('SIGKILL');
    throw error;
  });

  return { child, endpoint };
}

/**
 * One CDP connection, with request/response matched by id.
 *
 * Small enough to read in one sitting, which is the argument for it existing
 * rather than a dependency doing the same thing.
 */
function connect(endpoint, { timeoutMs = 20_000 } = {}) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('the browser connection failed')), { once: true });
  });

  socket.addEventListener('message', event => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }

    if (frame.id && pending.has(frame.id)) {
      const { resolve, reject, timer } = pending.get(frame.id);
      clearTimeout(timer);
      pending.delete(frame.id);
      if (frame.error) reject(new Error(frame.error.message || 'the browser rejected a command'));
      else resolve(frame.result ?? {});
      return;
    }

    for (const listener of listeners) {
      try { listener(frame); } catch { /* one bad listener must not stop the session */ }
    }
  });

  socket.addEventListener('close', () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('the browser closed the connection'));
    }
    pending.clear();
  });

  return {
    ready,
    /**
     * @param {string} method
     * @param {object} params
     * @param {string} [sessionId]  the attached target, when the command is
     *   for a page rather than the browser. Chrome routes on the frame's own
     *   `sessionId`, not on one inside `params` — getting that wrong produces
     *   a puzzling "'Page.navigate' wasn't found".
     */
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { try { socket.close(); } catch { /* already gone */ } }
  };
}

/**
 * What a person notices about a page without reading its source.
 *
 * Run inside the page, because it is the only place these questions have
 * answers. Horizontal scroll and its causes are first because they are the
 * single most common mobile layout bug and the hardest to see from markup.
 */
const INSPECT = `(() => {
  const doc = document.documentElement;
  const width = doc.clientWidth;
  const scrollsSideways = doc.scrollWidth > width + 1;

  /*
     Only elements that stick out to the *right*, and only when the page
     actually scrolls sideways.

     A hidden drawer sits at left: -306px by design; reporting it as an
     overflow sends the agent to fix something that is not broken. The symptom
     worth chasing is horizontal scroll, and only a right-hand overhang causes
     it.
  */
  const visible = el => {
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  };

  const overflowing = !scrollsSideways ? [] : [...document.querySelectorAll('body *')]
    .map(el => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ el, rect }) => rect.width > 0 && rect.right > width + 1 && visible(el))
    .slice(0, 12)
    .map(({ el, rect }) => {
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      return el.tagName.toLowerCase() + id + cls + ' (right edge ' + Math.round(rect.right) + 'px of ' + width + ')';
    });

  // A control smaller than about 24px is hard to hit on a phone. Skip-links
  // and other visually-hidden controls are not controls anybody hits, so they
  // are excluded rather than reported as bugs.
  const tiny = [...document.querySelectorAll('button, a, input, [role=button]')]
    .map(el => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ el, rect }) =>
      rect.width > 0 && rect.height > 0 &&
      rect.right > 0 && rect.bottom > 0 && rect.left < width &&
      (rect.width < 24 || rect.height < 24) && visible(el))
    .slice(0, 10)
    .map(({ el, rect }) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ' + Math.round(rect.width) + '×' + Math.round(rect.height) + 'px');

  return {
    title: document.title || null,
    // Without this a phone lays the page out at 980px and scales it down,
    // which is why an "unresponsive" site is usually just missing one tag.
    hasViewportMeta: Boolean(document.querySelector('meta[name=viewport]')),
    viewport: { width, height: doc.clientHeight },
    scrollsSideways,
    scrollWidth: doc.scrollWidth,
    overflowing,
    tinyTargets: tiny,
    imagesWithoutAlt: [...document.images].filter(img => !img.alt).length,
    headings: [...document.querySelectorAll('h1,h2,h3')].slice(0, 12).map(h => h.tagName + ' ' + h.textContent.trim().slice(0, 80)),
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 1500)
  };
})()`;

/**
 * Open a URL in a real browser, look at it, and photograph it.
 *
 * @param {string} url
 * @param {{width?:number, height?:number, fullPage?:boolean, waitMs?:number,
 *          deviceScaleFactor?:number, mobile?:boolean, timeoutMs?:number}} [options]
 * @returns {Promise<{png:Buffer, report:object}>}
 */
export async function capturePage(url, {
  width = 1280, height = 800, fullPage = false, waitMs = 400,
  deviceScaleFactor = 1, mobile = false, timeoutMs = 30_000
} = {}) {
  const binary = await findBrowser();
  if (!binary) {
    throw notConfigured(
      'a browser. Screenshots need Chrome or Chromium in the container — install it, or set CHROMIUM_PATH'
    );
  }
  if (!/^https?:\/\//i.test(String(url))) throw badRequest('A page to photograph needs a full http(s) URL.');

  const { child, endpoint } = await launch(binary);
  const session = connect(endpoint, { timeoutMs });

  /** Everything the page complained about while it was loading. */
  const problems = [];

  try {
    await session.ready;

    // A fresh tab, and a session attached to it. `flatten` puts target
    // messages on the same connection, which is what makes this one socket
    // rather than two.
    const { targetId } = await session.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });

    /** Everything below talks to the page, not to the browser. */
    const page = (method, params = {}) => session.send(method, params, sessionId);

    await page('Page.enable');
    await page('Runtime.enable');
    await page('Log.enable');

    const off = session.on(frame => {
      if (frame.sessionId !== sessionId) return;
      if (frame.method === 'Runtime.exceptionThrown') {
        const detail = frame.params?.exceptionDetails;
        problems.push(`uncaught: ${detail?.exception?.description ?? detail?.text ?? 'error'}`.slice(0, 300));
      }
      if (frame.method === 'Runtime.consoleAPICalled' && frame.params?.type === 'error') {
        const text = (frame.params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' ').trim();
        if (text) problems.push(`console.error: ${text}`.slice(0, 300));
      }
      if (frame.method === 'Log.entryAdded' && frame.params?.entry?.level === 'error') {
        const entry = frame.params.entry;
        problems.push(`${entry.source}: ${entry.text}`.slice(0, 300));
      }
    });

    await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });

    const loaded = new Promise(resolve => {
      const stop = session.on(frame => {
        if (frame.sessionId === sessionId && frame.method === 'Page.loadEventFired') { stop(); resolve(true); }
      });
      // A page that never fires load — a hung request, a websocket that stays
      // open — is still worth photographing.
      setTimeout(() => { stop(); resolve(false); }, Math.min(timeoutMs, 20_000));
    });

    await page('Page.navigate', { url });
    const fired = await loaded;

    // Rendering happens after load. Without this the screenshot catches the
    // frame before fonts, images and the first paint of anything client-side.
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 10_000)));

    const inspection = await page('Runtime.evaluate', {
      expression: INSPECT, returnByValue: true, awaitPromise: false
    }).then(result => result?.result?.value ?? null).catch(() => null);

    const shot = await page('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
      optimizeForSpeed: false
    });

    off();
    await session.send('Target.closeTarget', { targetId }).catch(() => {});

    return {
      png: Buffer.from(shot.data, 'base64'),
      report: {
        url,
        loaded: fired,
        // What was asked for, and what the page did with it. Spreading the
        // inspection last means `viewport` is the page's own layout width,
        // which is the one that explains a layout.
        device: { width, height, deviceScaleFactor, mobile },
        problems: [...new Set(problems)].slice(0, 12),
        viewport: { width, height },
        ...(inspection ?? {})
      }
    };
  } finally {
    session.close();
    child.kill('SIGKILL');
  }
}

export { CANDIDATES, INSPECT };

/** Log once, at boot, so a deployment knows what it can do. */
export async function reportBrowser() {
  const binary = await findBrowser();
  if (binary) logger.info('browser available for screenshots', { binary });
  return binary;
}
