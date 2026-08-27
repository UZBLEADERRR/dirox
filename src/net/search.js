/**
 * Searching the web.
 *
 * Every serious search API costs money and needs a key, and a deployment that
 * has not bought one should still be able to look something up. So there are
 * two paths and the difference between them is stated rather than hidden:
 *
 *   A key is configured    the provider's API. Ranked, stable, rate-limited by
 *                          a contract we can reason about.
 *   No key                 DuckDuckGo's HTML endpoint, parsed. It works, it is
 *                          free, and it can be throttled or changed without
 *                          warning — so when it fails the agent is told what
 *                          the deployment is missing rather than "search
 *                          failed".
 *
 * Which provider is in use is part of the result. An agent that does not know
 * whether it is reading ranked results or a scraped page cannot weigh them.
 */

import { config } from '../config/env.js';
import { safeFetch } from './safefetch.js';
import { decodeEntities } from './readable.js';
import { badRequest, upstreamFailed } from '../core/errors.js';

/** Providers, in the order they are preferred when several are configured. */
const PROVIDERS = ['brave', 'tavily', 'serper', 'duckduckgo'];

export function searchProvider() {
  if (config.search?.braveKey) return 'brave';
  if (config.search?.tavilyKey) return 'tavily';
  if (config.search?.serperKey) return 'serper';
  return 'duckduckgo';
}

async function brave(query, count) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const response = await safeFetch(url, {
    headers: { accept: 'application/json', 'x-subscription-token': config.search.braveKey }
  });
  if (response.status !== 200) throw upstreamFailed(`Brave Search answered ${response.status}`);

  const data = JSON.parse(response.body.toString('utf8'));
  return (data.web?.results ?? []).map(item => ({
    title: item.title, url: item.url, snippet: item.description || ''
  }));
}

async function tavily(query, count) {
  const response = await safeFetch('https://api.tavily.com/search', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.search.tavilyKey}` },
    method: 'POST',
    body: JSON.stringify({ query, max_results: count })
  });
  if (response.status !== 200) throw upstreamFailed(`Tavily answered ${response.status}`);

  const data = JSON.parse(response.body.toString('utf8'));
  return (data.results ?? []).map(item => ({
    title: item.title, url: item.url, snippet: item.content || ''
  }));
}

async function serper(query, count) {
  const response = await safeFetch('https://google.serper.dev/search', {
    headers: { 'content-type': 'application/json', 'x-api-key': config.search.serperKey },
    method: 'POST',
    body: JSON.stringify({ q: query, num: count })
  });
  if (response.status !== 200) throw upstreamFailed(`Serper answered ${response.status}`);

  const data = JSON.parse(response.body.toString('utf8'));
  return (data.organic ?? []).map(item => ({
    title: item.title, url: item.link, snippet: item.snippet || ''
  }));
}

/**
 * DuckDuckGo's HTML endpoint, parsed.
 *
 * Deliberately narrow: three captures against a known shape, and if the shape
 * changes the result is zero rows rather than nonsense. Every field is decoded
 * and the redirect wrapper is unwrapped, because a result whose URL is
 * `//duckduckgo.com/l/?uddg=…` is not useful to fetch.
 */
export function parseDuckDuckGo(html, limit = 8) {
  const results = [];
  const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = pattern.exec(html)) && results.length < limit) {
    const href = unwrapRedirect(decodeEntities(match[1]));
    const title = decodeEntities(match[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!href || !title) continue;
    results.push({ title, url: href, snippet: '' });
  }

  // Snippets live in a sibling element; matched separately so a change to one
  // does not take out the other.
  const snippets = [...html.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(entry => decodeEntities(entry[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());

  results.forEach((result, index) => { result.snippet = snippets[index] ?? ''; });
  return results;
}

/** `//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com` → `https://example.com`. */
function unwrapRedirect(href) {
  const match = String(href).match(/[?&]uddg=([^&]+)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { return ''; }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

async function duckduckgo(query, count) {
  const response = await safeFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (response.status !== 200) {
    throw upstreamFailed(
      `The free search endpoint answered ${response.status}. ` +
      'Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY or SERPER_API_KEY for a search provider that will not throttle.'
    );
  }
  return parseDuckDuckGo(response.body.toString('utf8'), count);
}

const RUNNERS = { brave, tavily, serper, duckduckgo };

/**
 * @param {string} query
 * @param {{count?:number, provider?:string}} [options]
 * @returns {Promise<{provider:string, results:Array<{title:string,url:string,snippet:string}>}>}
 */
export async function searchWeb(query, { count = 6, provider } = {}) {
  const text = String(query || '').trim();
  if (!text) throw badRequest('A search needs something to search for.');

  const chosen = provider && PROVIDERS.includes(provider) ? provider : searchProvider();
  const results = await RUNNERS[chosen](text, Math.min(Math.max(count, 1), 10));

  return { provider: chosen, results };
}

export { PROVIDERS };
