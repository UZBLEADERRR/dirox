/** The DiroxCode mark: a crescent with a four-point star, drawn geometrically. */

import { h } from '../lib/dom.js';

export function mark({ size = 26, className = 'brand__mark' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);

  // Outer disc minus an offset disc: the difference is the crescent.
  const crescent = document.createElementNS(ns, 'path');
  crescent.setAttribute('d', 'M24 3a21 21 0 1 0 0 42 21 21 0 1 0 0-42Zm9.5 3.2a17.5 17.5 0 1 1 0 35.6 17.5 17.5 0 1 1 0-35.6Z');
  crescent.setAttribute('fill-rule', 'evenodd');

  const star = document.createElementNS(ns, 'path');
  star.setAttribute('d', 'M33.5 15.2 36 22 42.8 24.5 36 27 33.5 33.8 31 27 24.2 24.5 31 22Z');

  svg.append(crescent, star);
  return svg;
}

export function wordmark({ size = 26, href = '/' } = {}) {
  return h('a.brand', { href, 'aria-label': 'DiroxCode home' },
    mark({ size }),
    h('span.brand__name', 'Dirox', h('em', 'Code'))
  );
}
