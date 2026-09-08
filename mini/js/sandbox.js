/**
 * The mini-app runtime.
 *
 * Generated code runs in an iframe with `sandbox="allow-scripts"`, which puts
 * it on an opaque origin: it cannot reach this page, its localStorage, or the
 * API key. The price is that the iframe's own `localStorage` throws, so a shim
 * replaces it with a synchronous in-memory Storage seeded from the host and
 * mirrored back over postMessage. Generated apps just write `localStorage` and
 * it persists, which is what a model will produce anyway.
 *
 * The same shim is what makes the agent able to test its own work: it collects
 * errors, walks the DOM, clicks things, and can render the page to a JPEG
 * through an SVG foreignObject — no libraries, no network.
 */

import { appData, setAppData } from './store.js';

const CHECK_ID = '__check__';

const RPC_TIMEOUT = 9000;

/* ------------------------------------------------------------------ shim */

const SHIM = `
(function(){
  var HOST = null, PENDING = {}, SEQ = 0;
  var LOG = { errors: [], warns: [] };

  /* --- storage --- */
  var data = window.__MINI_SEED__ || {};
  delete window.__MINI_SEED__;
  var dirty = false, tick = null;
  function flush(){ tick = null; if (!dirty) return; dirty = false;
    parent.postMessage({ __mini:1, ev:'store', data: data }, '*'); }
  function mark(){ dirty = true; if (!tick) tick = setTimeout(flush, 120); }
  var base = {
    getItem: function(k){ return Object.prototype.hasOwnProperty.call(data, String(k)) ? data[String(k)] : null; },
    setItem: function(k,v){ data[String(k)] = String(v); mark(); },
    removeItem: function(k){ delete data[String(k)]; mark(); },
    clear: function(){ data = {}; mark(); },
    key: function(i){ return Object.keys(data)[i] ?? null; },
  };
  var shim = new Proxy(base, {
    get: function(t,p){
      if (p === 'length') return Object.keys(data).length;
      if (p in t) return t[p];
      if (typeof p === 'string') return base.getItem(p);
      return undefined;
    },
    set: function(t,p,v){ if (typeof p === 'string' && !(p in t)) base.setItem(p, v); return true; },
    deleteProperty: function(t,p){ base.removeItem(p); return true; },
    has: function(t,p){ return p in t || Object.prototype.hasOwnProperty.call(data, p); },
    ownKeys: function(){ return Object.keys(data); },
    getOwnPropertyDescriptor: function(t,p){
      if (Object.prototype.hasOwnProperty.call(data,p))
        return { value: data[p], enumerable:true, configurable:true, writable:true };
      return Object.getOwnPropertyDescriptor(t,p);
    }
  });
  /* localStorage is [LegacyUnforgeable] in some engines (Safari), so the
     override can fail. compose() also rewrites the identifier in every script
     to __miniLS, which needs no cooperation from the engine at all. */
  window.__miniLS = shim;
  window.MiniStore = shim;
  try { Object.defineProperty(window, 'localStorage', { value: shim, configurable:true }); } catch(e){}
  try { Object.defineProperty(window, 'sessionStorage', { value: shim, configurable:true }); } catch(e){}

  /* --- diagnostics --- */
  function note(list, msg){ if (list.length < 12) list.push(String(msg).slice(0, 240)); }
  window.addEventListener('error', function(e){
    var el = e.target;
    if (el && el !== window && el.tagName) {           /* a resource, not a throw */
      var src = (el.currentSrc || el.src || el.href || '').slice(0, 60);
      return note(LOG.errors, el.tagName.toLowerCase() + ' failed to load: ' + (src || '(no source)'));
    }
    note(LOG.errors, (e.message || 'error') + (e.lineno ? ' @' + e.lineno : ''));
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    note(LOG.errors, 'Promise: ' + ((e.reason && (e.reason.message || e.reason)) || 'rejected'));
  });
  var ce = console.error, cw = console.warn;
  console.error = function(){ note(LOG.errors, [].join.call(arguments,' ')); ce.apply(console, arguments); };
  console.warn  = function(){ note(LOG.warns,  [].join.call(arguments,' ')); cw.apply(console, arguments); };

  /* --- inspection --- */
  function visible(el){
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }
  function inspect(){
    var body = document.body;
    var text = (body ? (body.innerText || '') : '').replace(/\\s+/g,' ').trim();
    var controls = [].slice.call(document.querySelectorAll('button,[role=button],input,select,textarea,a[href]'));
    var named = controls.slice(0, 24).map(function(el){
      var label = (el.getAttribute('aria-label') || el.value || el.textContent || el.placeholder || '').trim().slice(0,24);
      return el.tagName.toLowerCase() + (label ? '(' + label + ')' : '');
    });
    var off = 0;
    [].forEach.call(document.querySelectorAll('body *'), function(el){
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > innerWidth + 2) off++;
    });
    return {
      title: document.title || '',
      chars: text.length,
      text: text.slice(0, 320),
      nodes: document.querySelectorAll('body *').length,
      controls: named,
      controlCount: controls.length,
      overflowX: (document.documentElement.scrollWidth > innerWidth + 2),
      offscreen: off,
      blank: text.length < 2 && document.querySelectorAll('body *').length < 3,
      errors: LOG.errors.slice(),
      warns: LOG.warns.slice()
    };
  }
  function smoke(){
    var before = LOG.errors.length;
    var els = [].slice.call(document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]'))
                .filter(visible).slice(0, 10);
    els.forEach(function(el){
      try { el.click(); } catch(e){ note(LOG.errors, 'click ' + (el.textContent||'').trim().slice(0,16) + ': ' + e.message); }
    });
    return { clicked: els.length, newErrors: LOG.errors.slice(before) };
  }
  function shot(){
    var w = Math.min(window.innerWidth || 390, 420);
    var h = Math.min(Math.max(document.documentElement.scrollHeight, window.innerHeight || 700), 900);
    var clone = document.documentElement.cloneNode(true);
    [].forEach.call(clone.querySelectorAll('script,noscript'), function(n){ n.remove(); });
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    var xhtml = new XMLSerializer().serializeToString(clone);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
              '<foreignObject width="100%" height="100%">' + xhtml + '</foreignObject></svg>';
    return new Promise(function(resolve, reject){
      var img = new Image();
      img.onload = function(){
        try {
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0,0,w,h);
          g.drawImage(img, 0, 0);
          resolve(c.toDataURL('image/jpeg', 0.62));
        } catch(e){ reject(new Error('canvas: ' + e.message)); }
      };
      img.onerror = function(){ reject(new Error('render failed')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  /* --- rpc --- */
  window.addEventListener('message', function(e){
    var m = e.data;
    if (!m || m.__mini !== 1 || !m.op) return;
    var reply = function(ok, result){ parent.postMessage({ __mini:1, id:m.id, ok:ok, result:result }, '*'); };
    try {
      if (m.op === 'inspect') return reply(true, inspect());
      if (m.op === 'smoke')   return reply(true, smoke());
      if (m.op === 'reset')   { LOG.errors = []; LOG.warns = []; return reply(true, 1); }
      if (m.op === 'shot')    return shot().then(function(d){ reply(true, d); },
                                               function(err){ reply(false, err.message); });
      reply(false, 'unknown op');
    } catch(err){ reply(false, String(err && err.message || err)); }
  });

  function ready(){ parent.postMessage({ __mini:1, ev:'ready' }, '*'); }
  if (document.readyState === 'complete') setTimeout(ready, 0);
  else window.addEventListener('load', ready);
})();
`;

/* --------------------------------------------------------------- compose */

const esc = s => String(s).replace(/<\/script/gi, '<\\/script');

/** Fold style/script/asset references into one self-contained document. */
export function compose(project, { seed = {} } = {}) {
  const files = project.files || {};
  let html = files['index.html'] || files['index.htm'] ||
    '<!doctype html><html><body><p style="font:16px system-ui;padding:24px">No index.html</p></body></html>';

  // <link rel=stylesheet href="x.css">  ->  <style>…</style>
  html = html.replace(/<link[^>]+href=["']?([^"'\s>]+\.css)["']?[^>]*>/gi,
    (m, href) => files[href.replace(/^\.?\//, '')]
      ? `<style>\n${files[href.replace(/^\.?\//, '')]}\n</style>` : m);

  // <script src="x.js"></script>  ->  inline
  html = html.replace(/<script[^>]+src=["']?([^"'\s>]+\.js)["']?[^>]*><\/script>/gi,
    (m, src) => {
      const key = src.replace(/^\.?\//, '');
      return files[key] ? `<script>\n${esc(files[key])}\n</script>` : m;
    });

  // assets/foo.png -> data url
  for (const a of project.assets || []) {
    const names = [a.name, 'assets/' + a.name, './' + a.name, './assets/' + a.name];
    for (const n of names) {
      html = html.split(`"${n}"`).join(`"${a.data}"`).split(`'${n}'`).join(`'${a.data}'`);
    }
  }

  html = rewriteStorage(html);

  const head = `<script>window.__MINI_SEED__=${esc(JSON.stringify(seed))};</script><script>${SHIM}</script>`;
  if (/<head[^>]*>/i.test(html))      html = html.replace(/<head[^>]*>/i, m => m + head);
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, m => m + '<head>' + head + '</head>');
  else                                html = head + html;

  if (!/viewport/i.test(html)) {
    html = html.replace(/<head[^>]*>/i,
      m => m + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">');
  }
  return html;
}

/**
 * Points every storage call at the bridge.
 *
 * Only script bodies and inline handlers are touched, so prose on the page
 * that happens to mention localStorage is left alone.
 */
function rewriteStorage(html) {
  const swap = js => js
    .replace(/\b(?:window|globalThis|self)\.(localStorage|sessionStorage)\b/g, '__miniLS')
    .replace(/\b(?:localStorage|sessionStorage)\b/g, '__miniLS');

  return html
    .replace(/(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi,
             (m, open, body, close) => open + swap(body) + close)
    .replace(/\son([a-z]+)=(["'])([\s\S]*?)\2/gi,
             (m, ev, q, body) => ` on${ev}=${q}${swap(body)}${q}`);
}

/**
 * The same document with every script removed.
 *
 * Used for printing: the print view runs in a top-level window on this origin,
 * so nothing from the app may execute there. What is left is the markup and
 * the print stylesheet, which is all a PDF needs.
 */
export function printableHtml(project, seed = {}) {
  return compose(project, { seed })
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son([a-z]+)=(["'])[\s\S]*?\2/gi, '');
}

/* ----------------------------------------------------------------- mount */

let seq = 0;

/**
 * Runs a project inside `container`. `appId` namespaces persisted app data;
 * `device` swaps the strict sandbox for one that can reach the camera — at the
 * cost of same-origin, which the UI warns about before it is ever enabled.
 */
export function mount(container, project, { appId = 'draft', device = false } = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox',
    'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock' +
    (device ? ' allow-same-origin' : ''));
  frame.setAttribute('allow', 'camera; microphone; geolocation; fullscreen; accelerometer; gyroscope');
  frame.setAttribute('referrerpolicy', 'no-referrer');

  const pending = new Map();
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  const onMessage = (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.__mini !== 1) return;
    if (m.ev === 'ready') return readyResolve(true);
    if (m.ev === 'store') return setAppData(appId, m.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.result || 'failed'));
  };
  window.addEventListener('message', onMessage);

  frame.srcdoc = compose(project, { seed: appData(appId) });
  container.innerHTML = '';
  container.appendChild(frame);

  const call = (op, arg) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); }
    }, RPC_TIMEOUT);
    frame.contentWindow?.postMessage({ __mini:1, id, op, arg }, '*');
  });

  return {
    frame, ready, call,
    destroy() { window.removeEventListener('message', onMessage); frame.remove(); },
  };
}

/* ------------------------------------------------------------ agent test */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Boot the project off-screen, let it settle, poke it, and report back. */
export async function runCheck(project, { interact = true, shot = false } = {}) {
  const host = document.getElementById('sandbox-hidden');
  setAppData(CHECK_ID, {});                 // every check starts from a clean slate
  const app = mount(host, project, { appId: CHECK_ID });
  const out = { errors: [], warns: [] };
  try {
    await Promise.race([app.ready, sleep(3000)]);
    await sleep(450);
    const first = await app.call('inspect');
    Object.assign(out, first);
    if (interact && !first.blank) {
      const s = await app.call('smoke');
      await sleep(250);
      out.clicked = s.clicked;
      out.clickErrors = s.newErrors;
      const after = await app.call('inspect');
      out.errors = after.errors;
      out.warns = after.warns;
      out.chars = after.chars;
      out.text = after.text;
    }
    if (shot) {
      try { out.shot = await app.call('shot'); } catch (e) { out.shotError = e.message; }
    }
  } catch (e) {
    out.fatal = e.message;
  } finally {
    app.destroy();
  }
  return out;
}

/** Compact, model-facing summary. Kept short on purpose — tokens cost money. */
export function formatCheck(r) {
  const L = [];
  if (r.fatal) L.push(`FATAL: ${r.fatal}`);
  if (r.blank) L.push('BLANK: nothing visible on the page.');
  L.push(`title="${r.title || ''}" nodes=${r.nodes || 0} text=${r.chars || 0}ch controls=${r.controlCount || 0}`);
  if (r.controls?.length) L.push('UI: ' + r.controls.join(', '));
  if (r.overflowX) L.push('WARNING: the page scrolls horizontally — it does not fit a phone.');
  if (r.offscreen) L.push(`WARNING: ${r.offscreen} elements run past the right edge.`);
  if (r.clicked != null) L.push(`Clicked ${r.clicked} controls.`);
  const errs = [...new Set([...(r.errors || []), ...(r.clickErrors || [])])];
  if (errs.length) L.push('ERRORS:\n- ' + errs.slice(0, 8).join('\n- '));
  else L.push('No errors.');
  if (r.warns?.length) L.push('Warnings: ' + r.warns.slice(0, 3).join(' | '));
  if (r.text) L.push('Visible text: ' + r.text.slice(0, 200));
  return L.join('\n').slice(0, 1600);
}
