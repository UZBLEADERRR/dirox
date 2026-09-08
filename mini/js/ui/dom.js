/** Tiny DOM helpers. No framework — the whole app is ~10 screens. */

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : String(kid));
  return n;
}

/** A list-row icon: the mark in a soft tile, instead of a stock emoji. */
export function iconTile(path, tone = '') {
  return el('span', { class:`li-ic ${tone}` }, svg(path));
}

export function svg(path, extra = '') {
  return el('span', { html:`<svg viewBox="0 0 24 24" ${extra}>${path}</svg>` }).firstChild;
}
export const ICON = {
  check: '<path d="M5 13l4 4L19 7"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  kebab: '<circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
  x:     '<path d="M6 6l12 12M18 6L6 18"/>',
  play:  '<path d="M8 5l11 7-11 7z"/>',
  home:  '<path d="M4 11l8-7 8 7v9H4z"/>',
  plus:  '<path d="M12 5v14M5 12h14"/>',
  share:  '<path d="M12 16V4M8 8l4-4 4 4M5 14v5h14v-5"/>',
  link:    '<path d="M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1"/>',
  external:'<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  download:'<path d="M12 3v13M7 12l5 5 5-5M4 20h16"/>',
  key:     '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2"/>',
  exit:    '<path d="M14 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 8l-4 4 4 4M6 12h9"/>',
  code:    '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
  rocket:  '<path d="M12 3c3.5 2 5.5 5.5 5.5 9L12 17l-5.5-5C6.5 8.5 8.5 5 12 3zM9 17l-2 4 4-2M15 17l2 4-4-2"/><circle cx="12" cy="10" r="1.6"/>',
  printer: '<path d="M7 9V3h10v6M7 19H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2M7 15h10v6H7z"/>',
  pencil:  '<path d="M4 20h4L20 8a2.8 2.8 0 00-4-4L4 16v4z"/>',
  play:    '<path d="M8 5l11 7-11 7z"/>',
  grid:    '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  image:   '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M4 17l5-5 4 4 2-2 5 5"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  doc:     '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h4"/>',
  search:  '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
};

/* ------------------------------------------------------------- feedback */

export function toast(msg, ms = 2200) {
  const wrap = $('#toast-wrap');
  const n = el('div', { class:'toast', text:msg });
  wrap.appendChild(n);
  setTimeout(() => { n.style.opacity = '0'; n.style.transition = 'opacity .2s'; }, ms - 200);
  setTimeout(() => n.remove(), ms);
}

/* ---------------------------------------------------------------- sheet */

let sheetClose = null, sheetOwnsEntry = false;

/**
 * Sheets and overlays share one history budget so the Android back button
 * closes what is on screen instead of leaving the app.
 *
 * The subtlety is that `history.back()` is asynchronous: a sheet that closes
 * itself and immediately opens another would push a new entry before the back
 * lands, and the app would walk off the beginning of its own history. So a
 * sheet holds at most one entry, hands it to whatever opens next, and only
 * gives it back once nothing has claimed it by the end of the tick.
 */
let owned = 0, ignored = 0;

export function pushHistory() { owned++; history.pushState({ mini:owned }, ''); }

/** Close something programmatically: unwind our entry, swallow the popstate. */
export function popHistory() { if (owned > 0) { owned--; ignored++; history.back(); } }

/** @returns false when the popstate we just got was one we caused ourselves. */
export function notePop() {
  if (ignored > 0) { ignored--; return false; }
  if (owned > 0) owned--;
  return true;
}
export const resetHistory = () => { owned = 0; ignored = 0; sheetOwnsEntry = false; };

export function openSheet(build, { onClose } = {}) {
  const wrap = $('#sheet-wrap'), body = $('#sheet-body');
  body.innerHTML = '';
  body.append(...[].concat(build(closeSheet)).filter(Boolean));
  wrap.hidden = false;
  document.body.style.overflow = 'hidden';
  sheetClose = onClose || null;
  if (!sheetOwnsEntry) { sheetOwnsEntry = true; pushHistory(); }
  return closeSheet;
}

export function closeSheet(fromPop = false) {
  const wrap = $('#sheet-wrap');
  if (wrap.hidden) return;
  wrap.hidden = true;
  document.body.style.overflow = '';
  const cb = sheetClose; sheetClose = null;
  cb?.();
  if (fromPop) { sheetOwnsEntry = false; return; }
  // Give any sheet opened in the same tick a chance to take the entry over.
  setTimeout(() => {
    if (sheetOwnsEntry && wrap.hidden) { sheetOwnsEntry = false; popHistory(); }
  }, 0);
}

export const sheetOpen = () => !$('#sheet-wrap').hidden;

export function confirmSheet({ title, text, ok, danger = true }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; closeSheet(); resolve(v); } };
    openSheet(() => [
      el('h3', { text:title }),
      text ? el('p', { class:'note', text }) : null,
      el('div', { class:'btn-row' },
        el('button', { class:'btn', text:'Bekor', onClick:() => finish(false) }),
        el('button', { class:`btn ${danger ? 'danger' : 'primary'}`, text:ok, onClick:() => finish(true) })),
    ], { onClose:() => finish(false) });
  });
}

export function switchRow(label, sub, value, onChange) {
  const tog = el('div', { class:`toggle ${value ? 'on' : ''}` });
  return el('div', { class:'switch', onClick:() => {
    value = !value; tog.classList.toggle('on', value); onChange(value);
  }},
    el('div', { class:'txt' }, el('b', { text:label }), sub ? el('small', { text:sub }) : null),
    tog);
}

export function field(label, input, hint) {
  return el('div', { class:'field' },
    el('label', { text:label }), input,
    hint ? el('div', { class:'hint', html:hint }) : null);
}

/* --------------------------------------------------------------- images */

/** Downscales an image file to a data URL small enough to keep in localStorage. */
export function readImage(file, max = 1024, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('read failed'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

export const fmtBytes = n =>
  n > 1e6 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
