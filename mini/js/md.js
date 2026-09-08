/** A markdown subset. Escapes first, formats second — never the other way. */

const esc = s => s.replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function md(src) {
  const out = [];
  const lines = String(src || '').split('\n');
  let i = 0, list = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {                       // fenced code
      const lang = line.replace(/^\s*```/, '').trim();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      closeList();
      out.push(`<pre data-lang="${esc(lang)}"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`); i++; continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`); i++; continue;
    }

    if (!line.trim()) { closeList(); i++; continue; }

    closeList();
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,3}\s|[-*+]\s|\d+[.)]\s)/.test(lines[i]))
      para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  closeList();
  return out.join('');
}
