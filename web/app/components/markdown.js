/**
 * Markdown rendering.
 *
 * Deliberately built on DOM construction rather than an HTML string: model
 * output is untrusted text, and building nodes means it can never become
 * markup. There is no innerHTML in this file.
 */

import { h, frag } from '../lib/dom.js';

/** Split source into fenced code blocks and everything else. */
function splitBlocks(source) {
  const blocks = [];
  const lines = String(source).split('\n');
  let buffer = [];
  let fence = null;
  let language = '';

  const flushText = () => {
    if (buffer.length) { blocks.push({ type: 'text', content: buffer.join('\n') }); buffer = []; }
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)\s*(\S*)/.exec(line);
    if (fenceMatch && !fence) {
      flushText();
      fence = fenceMatch[1][0].repeat(3);
      language = fenceMatch[2] || '';
      continue;
    }
    if (fence && new RegExp(`^\\s*${fence[0]}{3,}\\s*$`).test(line)) {
      blocks.push({ type: 'code', language, content: buffer.join('\n') });
      buffer = [];
      fence = null;
      language = '';
      continue;
    }
    buffer.push(line);
  }

  if (fence) blocks.push({ type: 'code', language, content: buffer.join('\n') });
  else flushText();

  return blocks;
}

/** Inline formatting: code, bold, italic, links, file references. */
function renderInline(text, { onFileClick } = {}) {
  const nodes = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let match;

  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(...linkifyPaths(text.slice(last, match.index), { onFileClick }));
    const token = match[0];

    if (token.startsWith('`')) {
      nodes.push(h('code', token.slice(1, -1)));
    } else if (token.startsWith('**')) {
      nodes.push(h('strong', token.slice(2, -2)));
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = linkMatch[2];
      // Only http(s) and in-app paths become links; anything else stays text.
      const safe = /^(https?:\/\/|\/)/i.test(href);
      nodes.push(safe
        ? h('a', { href, ...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {}), style: { color: 'var(--accent)' } }, linkMatch[1])
        : document.createTextNode(token));
    } else {
      nodes.push(h('em', token.slice(1, -1)));
    }
    last = pattern.lastIndex;
  }

  if (last < text.length) nodes.push(...linkifyPaths(text.slice(last), { onFileClick }));
  return nodes;
}

/** Turn `src/auth.ts:42` into a clickable reference. */
function linkifyPaths(text, { onFileClick }) {
  if (!onFileClick) return [document.createTextNode(text)];

  const nodes = [];
  const pattern = /\b([\w./-]+\.(?:[jt]sx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|vue|svelte|css|scss|html|json|ya?ml|sql|md))(?::(\d+))?\b/g;
  let last = 0;
  let match;

  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(document.createTextNode(text.slice(last, match.index)));
    const [full, path, line] = match;
    nodes.push(h('button.file-ref', {
      type: 'button',
      title: `Open ${path}`,
      onClick: () => onFileClick(path, line ? Number(line) : null)
    }, full));
    last = pattern.lastIndex;
  }

  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

function renderTextBlock(content, options) {
  const out = [];
  const lines = content.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) { index += 1; continue; }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(h(`h${Math.min(6, heading[1].length + 2)}`, renderInline(heading[2], options)));
      index += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.trim().length >= 3) {
      out.push(h('hr'));
      index += 1;
      continue;
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      out.push(h('blockquote', renderInline(quote.join(' '), options)));
      continue;
    }

    // Lists
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items = [];
      while (index < lines.length) {
        const itemMatch = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[index]) : /^\s*[-*+]\s+(.*)$/.exec(lines[index]);
        if (!itemMatch) break;
        items.push(h('li', renderInline(itemMatch[1], options)));
        index += 1;
      }
      out.push(h(ordered ? 'ol' : 'ul', items));
      continue;
    }

    // Paragraph
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^\s*([-*+]|\d+[.)]|#{1,6}\s|>)/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) out.push(h('p', renderInline(paragraph.join(' '), options)));
    else index += 1;
  }

  return out;
}

function renderCodeBlock({ language, content }) {
  const copy = h('button.btn.btn--ghost.btn--sm', {
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(content);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      } catch {
        copy.textContent = 'Copy failed';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      }
    }
  }, 'Copy');

  return h('div.code',
    h('div.code__head', h('span', language || 'text'), copy),
    h('pre', h('code', content))
  );
}

/**
 * @param {string} source
 * @param {{onFileClick?: (path:string, line:number|null) => void}} options
 * @returns {DocumentFragment}
 */
export function renderMarkdown(source, options = {}) {
  const blocks = splitBlocks(source || '');
  return frag(blocks.map(block =>
    block.type === 'code' ? renderCodeBlock(block) : renderTextBlock(block.content, options)
  ));
}

/** Render a unified diff with per-line colouring. */
export function renderDiff(diffText) {
  const lines = String(diffText || '').split('\n');
  return h('div.diff', lines.slice(0, 800).map(line => {
    const variant = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')
      ? 'meta'
      : line.startsWith('+') ? 'add'
      : line.startsWith('-') ? 'del'
      : null;
    return h(`div.diff__line${variant ? `.diff__line--${variant}` : ''}`, line || ' ');
  }));
}
