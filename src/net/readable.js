/**
 * A web page, as something worth sending to a model.
 *
 * Raw HTML is mostly not the page. A news article is forty kilobytes of
 * navigation, cookie banner, share buttons, related-story rail and analytics
 * around two kilobytes of text — and the model pays for every byte of it,
 * twice, because it stays in the conversation afterwards.
 *
 * So the markup is reduced to what a person would have read. This is not a
 * browser and does not pretend to be: no CSS, no JavaScript, no layout. It
 * removes the parts that are definitely not content, keeps the parts that
 * definitely are, and preserves enough structure — headings, list items, links
 * — that the model can tell a heading from a sentence.
 *
 * Deterministic and dependency-free. A summariser that costs a model call to
 * save tokens has not saved anything.
 */

/** Elements whose contents are never page text. */
const DROPPED = /<(script|style|noscript|svg|canvas|template|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Wrappers that are chrome rather than content, when a page marks them. */
const CHROME = /<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Comments, doctypes and conditional blocks. */
const COMMENTS = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>/gi;

/** The handful of entities that actually appear in prose. */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·'
};

export function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => safeChar(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeChar(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

function safeChar(code) {
  return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
}

/** How much text a fragment of markup would come to, once the tags are gone. */
function textLength(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

/** The page's own title, which is often the best one-line description of it. */
export function pageTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeEntities((og?.[1] ?? title?.[1] ?? '').replace(/\s+/g, ' ').trim()).slice(0, 200) || null;
}

/** What a page says about itself, when it says anything. */
export function pageDescription(html) {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  return match ? decodeEntities(match[1].replace(/\s+/g, ' ').trim()).slice(0, 400) : null;
}

/**
 * HTML in, readable text out.
 *
 * @param {string} html
 * @param {{maxChars?:number, links?:boolean}} [options]
 * @returns {{title:string|null, description:string|null, text:string, truncated:boolean}}
 */
export function readable(html, { maxChars = 12_000, links = true } = {}) {
  const source = String(html || '');
  const title = pageTitle(source);
  const description = pageDescription(source);

  let body = source
    .replace(COMMENTS, ' ')
    .replace(DROPPED, ' ');

  /*
     Chrome goes, unless the chrome *was* the page.

     Stripping <form> and <nav> unconditionally is how a documentation search
     page or a wiki edit view comes back blank. The rule is proportional rather
     than absolute: if removing them takes away three quarters of the text,
     they were not decoration and they stay. A fixed character threshold got
     this wrong on short pages, which are exactly the ones with little to lose.
  */
  const full = textLength(body);
  const withoutChrome = body.replace(CHROME, ' ');
  if (textLength(withoutChrome) > full * 0.25) body = withoutChrome;

  // Structure that survives as punctuation, before the tags are stripped.
  body = body
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h1\b[^>]*>/gi, '\n\n# ')
    .replace(/<h2\b[^>]*>/gi, '\n\n## ')
    .replace(/<h3\b[^>]*>/gi, '\n\n### ')
    .replace(/<h[4-6]\b[^>]*>/gi, '\n\n#### ')
    .replace(/<td\b[^>]*>/gi, ' | ');

  if (links) {
    // A link's address is often the point — a docs page listing endpoints, a
    // search result. Kept inline and only when it is not the same as its text.
    body = body.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (whole, href, text) => {
      const label = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!label) return ' ';
      if (href.startsWith('#') || href.startsWith('javascript:')) return label;
      return label === href ? label : `${label} (${href})`;
    });
  }

  const text = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    // Collapse the whitespace that stripping tags leaves behind, without
    // losing the paragraph breaks that were just introduced.
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated = text.length > maxChars;
  return {
    title,
    description,
    text: truncated ? `${text.slice(0, maxChars)}\n\n… ${(text.length - maxChars).toLocaleString()} more characters` : text,
    truncated
  };
}

export { DROPPED, CHROME };
