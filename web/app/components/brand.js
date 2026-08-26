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

  const crescent = document.createElementNS(ns, 'path');
  crescent.setAttribute('d', 'M31 4a20 20 0 1 0 0 40 16 16 0 1 1 0-40Z');
  const star = document.createElementNS(ns, 'path');
  star.setAttribute('d', 'M33 17.5 34.9 22.6 40 24.5 34.9 26.4 33 31.5 31.1 26.4 26 24.5 31.1 22.6Z');

  svg.append(crescent, star);
  return svg;
}

export function wordmark({ size = 26, href = '/' } = {}) {
  return h('a.brand', { href, 'aria-label': 'DiroxCode home' },
    mark({ size }),
    h('span.brand__name', 'Dirox', h('em', 'Code'))
  );
}
