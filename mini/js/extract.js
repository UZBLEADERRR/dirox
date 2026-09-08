/**
 * Reading a document the user hands over.
 *
 * Plain text and HTML are easy. PDF and EPUB are not, and the usual answer is
 * a megabyte of library from a CDN — which this project does not allow itself.
 * So both are parsed here against the one decompressor every modern browser
 * already ships: `DecompressionStream`.
 *
 * The PDF reader is deliberately narrow. It walks Flate-compressed content
 * streams and pulls the strings out of the text-showing operators. That covers
 * PDFs produced by software — the kind people actually upload — and returns
 * nothing useful for a scan of a paper book, which it says rather than
 * pretending.
 */

const dec = new TextDecoder();
const latin = new TextDecoder('latin1');

export class ExtractError extends Error {}

/** @returns {{kind, title, text, chars, truncated}} */
export async function extractText(file, { maxChars = 400_000 } = {}) {
  const name = file.name || 'document';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const title = name.replace(/\.[^.]+$/, '');

  let text = '';
  let kind = ext;

  if (ext === 'txt' || ext === 'md' || ext === 'markdown' || ext === 'csv') {
    text = await file.text();
    kind = 'text';
  } else if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    text = stripTags(await file.text());
    kind = 'html';
  } else if (ext === 'pdf') {
    text = await pdfText(new Uint8Array(await file.arrayBuffer()));
    kind = 'pdf';
  } else if (ext === 'epub') {
    text = await epubText(new Uint8Array(await file.arrayBuffer()));
    kind = 'epub';
  } else {
    throw new ExtractError('unsupported');
  }

  text = tidy(text);
  if (!text || text.length < 40) throw new ExtractError('empty');

  const truncated = text.length > maxChars;
  return { kind, title, text: truncated ? text.slice(0, maxChars) : text,
           chars: text.length, truncated };
}

const tidy = s => s
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t ]+/g, ' ')
  .replace(/ ?\n ?/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

function stripTags(html) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function inflate(bytes, format = 'deflate') {
  if (typeof DecompressionStream === 'undefined') throw new ExtractError('no-decompressor');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------------- pdf */

const find = (hay, needle, from = 0) => {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};
const bytesOf = s => Uint8Array.from(s, c => c.charCodeAt(0));

const STREAM = bytesOf('stream');
const ENDSTREAM = bytesOf('endstream');

async function pdfText(buf) {
  const chunks = [];
  let at = 0;

  while (chunks.length < 4000) {
    const s = find(buf, STREAM, at);
    if (s < 0) break;
    const e = find(buf, ENDSTREAM, s);
    if (e < 0) break;

    // The dictionary sits just before `stream`; that is where the filter is.
    const head = latin.decode(buf.subarray(Math.max(0, s - 700), s));
    let start = s + STREAM.length;
    if (buf[start] === 13) start++;
    if (buf[start] === 10) start++;
    // The newline that separates the data from `endstream` is not data, and
    // the decompressor refuses anything trailing the compressed stream.
    let stop = e;
    while (stop > start && (buf[stop - 1] === 10 || buf[stop - 1] === 13)) stop--;
    const body = buf.subarray(start, stop);
    at = e + ENDSTREAM.length;

    if (!/\/FlateDecode/.test(head)) continue;
    if (/\/Image|\/DCTDecode|\/JPXDecode|\/ObjStm|\/XRef/.test(head)) continue;

    try { chunks.push(latin.decode(await inflate(body))); }
    catch { /* not a stream we can read; skip it */ }
  }

  if (!chunks.length) throw new ExtractError('pdf-unreadable');

  const out = chunks.map(readContentStream).filter(Boolean).join('\n\n');
  const printable = (out.match(/[\p{L}\p{N} .,]/gu) || []).length;
  if (out.length < 40 || printable / Math.max(1, out.length) < 0.6)
    throw new ExtractError('pdf-unreadable');
  return out;
}

/**
 * Pulls the shown strings out of one content stream.
 *
 * Only the operators that put glyphs on the page matter — Tj, TJ, ' and " —
 * plus the ones that move to a new line, which is where the line breaks come
 * from. Positioning, fonts and graphics are all skipped.
 */
function readContentStream(src) {
  let out = '';
  let i = 0;
  const n = src.length;

  const readLiteral = () => {                 // ( ... ) with escapes and nesting
    let depth = 1, s = '';
    i++;
    while (i < n && depth > 0) {
      const c = src[i];
      if (c === '\\') {
        const e = src[++i];
        const map = { n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', '(':'(', ')':')', '\\':'\\' };
        if (e >= '0' && e <= '7') {
          let oct = e;
          while (oct.length < 3 && src[i + 1] >= '0' && src[i + 1] <= '7') oct += src[++i];
          s += String.fromCharCode(parseInt(oct, 8));
        } else if (e === '\n') { /* line continuation */ }
        else s += map[e] ?? e;
        i++;
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') { depth--; if (!depth) { i++; break; } }
      s += c;
      i++;
    }
    return s;
  };

  const readHex = () => {                     // < ... >
    let s = '';
    i++;
    let hex = '';
    while (i < n && src[i] !== '>') { if (/[0-9a-fA-F]/.test(src[i])) hex += src[i]; i++; }
    i++;
    if (hex.length % 2) hex += '0';
    for (let k = 0; k < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
    return s;
  };

  while (i < n) {
    const c = src[i];
    if (c === '(') { out += readLiteral(); continue; }
    if (c === '<' && src[i + 1] !== '<') { out += readHex(); continue; }
    if (c === 'T') {
      const op = src.substr(i, 2);
      if (op === 'Td' || op === 'TD' || op === 'T*') { out += '\n'; i += 2; continue; }
      // Tj and TJ show what was just read; they add no character of their own.
      // Inserting a space here would land inside words, because generators
      // routinely split one word across several show operators.
      if (op === 'TJ' || op === 'Tj') { i += 2; continue; }
    }
    if (c === "'" || c === '"') { out += '\n'; i++; continue; }
    if (c === 'E' && src.substr(i, 2) === 'ET') { out += '\n'; i += 2; continue; }
    i++;
  }

  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n');
}

/* ------------------------------------------------------------------ epub */

async function epubText(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory, searched from the back past any comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ExtractError('epub-unreadable');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = [];

  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    files.push({ name, method, csize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const read = async (f) => {
    const lv = new DataView(buf.buffer, buf.byteOffset + f.offset, 30);
    if (lv.getUint32(0, true) !== 0x04034b50) return '';
    const start = f.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    const body = buf.subarray(start, start + f.csize);
    if (f.method === 0) return dec.decode(body);
    if (f.method === 8) return dec.decode(await inflate(body, 'deflate-raw'));
    return '';
  };

  // Spine order when the manifest is readable, filename order otherwise.
  const opf = files.find(f => /\.opf$/i.test(f.name));
  let order = [];
  if (opf) {
    const xml = await read(opf).catch(() => '');
    const ids = [...xml.matchAll(/<itemref[^>]+idref="([^"]+)"/g)].map(m => m[1]);
    const hrefs = new Map([...xml.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"/g)]
      .map(m => [m[1], m[2]]));
    const base = opf.name.includes('/') ? opf.name.replace(/[^/]+$/, '') : '';
    order = ids.map(id => hrefs.get(id)).filter(Boolean).map(h => base + h.replace(/^\.\//, ''));
  }

  const docs = files.filter(f => /\.x?html?$/i.test(f.name));
  const sorted = order.length
    ? order.map(h => docs.find(f => f.name === h || f.name.endsWith('/' + h))).filter(Boolean)
    : docs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const parts = [];
  for (const f of sorted.slice(0, 400)) {
    try { parts.push(stripTags(await read(f))); } catch {}
  }
  const out = parts.join('\n\n');
  if (out.replace(/\s/g, '').length < 100) throw new ExtractError('epub-unreadable');
  return out;
}

export const EXTRACT_MESSAGES = {
  unsupported: 'Unsupported file. Use PDF, EPUB, TXT, MD or HTML.',
  empty: 'No readable text in that file.',
  'pdf-unreadable': 'This PDF has no extractable text — it is probably a scan. Try an EPUB or a text file.',
  'epub-unreadable': 'Could not read that EPUB.',
  'no-decompressor': 'This browser is too old to read compressed documents.',
};
