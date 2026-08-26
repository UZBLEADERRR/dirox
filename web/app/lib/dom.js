/**
 * Tiny DOM helpers.
 *
 * The client has no framework and no build step: elements are created with
 * `h()`, which escapes text by construction — a string is only ever set through
 * `textContent`, never `innerHTML`. That removes a whole class of XSS from
 * rendering model output and repository content.
 *
 * There is deliberately no raw-markup escape hatch. An unused one is still a
 * foothold, and every case that seemed to need one was better served by
 * building nodes.
 */

/**
 * @param {string} tag  e.g. 'div.card.card--interactive' or 'button#send.btn'
 * @param {object} [props]
 * @param {...(Node|string|number|false|null|undefined|Array)} children
 */
export function h(tag, props, ...children) {
  const [name, ...rest] = String(tag).split(/(?=[.#])/);
  const element = document.createElement(name || 'div');

  for (const token of rest) {
    if (token.startsWith('.')) element.classList.add(token.slice(1));
    else if (token.startsWith('#')) element.id = token.slice(1);
  }

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') element.classList.add(...String(value).split(/\s+/).filter(Boolean));
      else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'ref' && typeof value === 'function') value(element);
      else if (value === true) element.setAttribute(key, '');
      else element.setAttribute(key, String(value));
    }
  } else if (props !== undefined && props !== null) {
    children.unshift(props);
  }

  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function frag(...children) {
  return append(document.createDocumentFragment(), children);
}

export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}

export function mount(element, ...children) {
  clear(element);
  return append(element, children);
}

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Inline SVG icon set. Geometric, 1.5px stroke, no decoration. */
const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  projects: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 18Z',
  tasks: 'M4 6h16M4 12h16M4 18h10',
  chat: 'M4 5.5h16v11H9l-5 3.5z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4',
  git: 'M6 3v12a3 3 0 0 0 3 3h6M6 18.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM6 1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM18 16.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20a7.5 7.5 0 0 1 15 0',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm4.5 12.5 5 5 10-11',
  chevronRight: 'm9 5 7 7-7 7',
  chevronDown: 'm5 9 7 7 7-7',
  file: 'M6 3h7l5 5v13H6zM13 3v5h5',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5Z',
  terminal: 'm5 7 5 5-5 5M13 17h6',
  play: 'M7 4.5 19 12 7 19.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  refresh: 'M20 11a8 8 0 1 0-1.5 6M20 5v6h-6',
  bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6ZM10.5 20a2 2 0 0 0 3 0',
  shield: 'M12 3 4.5 6v6c0 5 3.5 8 7.5 9 4-1 7.5-4 7.5-9V6Z',
  chart: 'M4 20V9M10 20V4M16 20v-7M22 20H2',
  credit: 'M3 7.5h18v10H3zM3 11h18',
  layers: 'm12 3 9 5-9 5-9-5zM3 13l9 5 9-5',
  warning: 'M12 4 2.5 20h19zM12 10v4M12 17.5v.5',
  sparkle: 'M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z',
  arrowRight: 'M4 12h15M13 6l6 6-6 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  panel: 'M3 5h18v14H3zM14 5v14',
  logout: 'M15 5H6v14h9M18 12H10M15 9l3 3-3 3'
};

export function icon(name, { size = 16, className = '' } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.file);
  svg.appendChild(path);
  return svg;
}

export function hasIcon(name) { return Object.hasOwn(ICONS, name); }

/** Focus trap for modals and sheets. Returns a release function. */
export function trapFocus(container, { onEscape } = {}) {
  const selector = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const previous = document.activeElement;

  function onKeydown(event) {
    if (event.key === 'Escape' && onEscape) { event.preventDefault(); onEscape(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...container.querySelectorAll(selector)].filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  container.addEventListener('keydown', onKeydown);
  queueMicrotask(() => (container.querySelector(selector) || container).focus?.());

  return () => {
    container.removeEventListener('keydown', onKeydown);
    if (previous instanceof HTMLElement) previous.focus();
  };
}

export function debounce(fn, waitMs = 200) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function onIdle(fn) {
  if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 1000 });
  else setTimeout(fn, 1);
}
