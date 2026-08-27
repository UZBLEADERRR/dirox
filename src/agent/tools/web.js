/**
 * Reading the web.
 *
 * A coding agent without this is stuck in May of whenever its model was
 * trained. Half of real work is looking something up: the shape of an API that
 * changed last month, why a library version broke, what a status code from a
 * payment provider means, whether the approach in a Stack Overflow answer is
 * still the current one.
 *
 * Two tools, because searching and reading are different acts with different
 * costs. A search returns eight lines and answers "where do I look". A fetch
 * returns a page and answers "what does it say". An agent that only had fetch
 * would guess at URLs; one that only had search would reason from snippets.
 *
 * Both are read-only and both go through the SSRF guard in `net/safefetch.js`,
 * which is where the actual danger lives — a URL chosen by a model is a URL
 * chosen by whatever the model last read.
 */

import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest } from '../../core/errors.js';
import { config } from '../../config/env.js';
import { safeFetch } from '../../net/safefetch.js';
import { readable } from '../../net/readable.js';
import { searchWeb, searchProvider } from '../../net/search.js';

/** How much of one page reaches the model by default. */
const DEFAULT_PAGE_CHARS = 10_000;

function assertEnabled() {
  if (config.search?.enabled === false) {
    throw badRequest('Web access is switched off on this deployment.');
  }
}

export const webTools = [
  {
    name: 'web_search',
    risk: RISK.SAFE,
    description:
      'Search the web and get back titles, addresses and snippets. ' +
      'Use it when the answer depends on something newer than your training, or on a specific library, error or API you cannot see in this repository. ' +
      'Read the promising results with web_fetch — a snippet is not an answer.',
    schema: t.object({
      query: t.string({ required: true, max: 300, description: 'What you would type into a search box' }),
      count: t.integer({ min: 1, max: 10, default: 6 })
    }),
    async run({ query, count }) {
      assertEnabled();
      const { provider, results } = await searchWeb(query, { count });

      if (!results.length) {
        return { ok: false, output: `No results for "${query}".`, metadata: { provider, results: 0 } };
      }

      const lines = results.map((result, index) =>
        `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet.slice(0, 300)}` : ''}`);

      return {
        // Which provider answered is part of the result: ranked API results
        // and a scraped page are not the same evidence, and an agent that
        // cannot tell them apart cannot weigh them.
        output: `${results.length} result(s) via ${provider}:\n\n${lines.join('\n\n')}`,
        metadata: { provider, results: results.length, urls: results.map(result => result.url) }
      };
    }
  },

  {
    name: 'web_fetch',
    risk: RISK.SAFE,
    description:
      'Fetch a web page or a JSON endpoint and read it as text. Markup, navigation and scripts are stripped; headings, lists and links survive. ' +
      'Give it a full https:// address.',
    schema: t.object({
      url: t.string({ required: true, max: 2000, description: 'A full http(s) URL' }),
      maxChars: t.integer({ min: 500, max: 40_000, default: DEFAULT_PAGE_CHARS })
    }),
    async run({ url, maxChars }) {
      assertEnabled();
      const response = await safeFetch(url);

      if (response.status >= 400) {
        return {
          ok: false,
          output: `${response.url} answered ${response.status}.`,
          metadata: { status: response.status, url: response.url }
        };
      }

      const type = response.contentType.toLowerCase();
      const raw = response.body.toString('utf8');

      // JSON is already structured; running it through an HTML reducer would
      // destroy the one thing that makes it useful.
      if (type.includes('json')) {
        const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n\n… truncated` : raw;
        return { output: `${response.url}\n\n${text}`, metadata: { url: response.url, contentType: type } };
      }

      if (type && !type.includes('html') && !type.includes('text') && !type.includes('xml')) {
        return {
          ok: false,
          output: `${response.url} is ${type.split(';')[0]}, which is not something to read as text.`,
          metadata: { url: response.url, contentType: type }
        };
      }

      const page = readable(raw, { maxChars });
      if (!page.text) {
        return {
          ok: false,
          output: `${response.url} returned no readable text. It may need JavaScript to render — try open_preview, or find another source.`,
          metadata: { url: response.url }
        };
      }

      return {
        output: [
          page.title ? `# ${page.title}` : null,
          response.url,
          page.description ? `\n${page.description}` : null,
          '',
          page.text
        ].filter(line => line !== null).join('\n'),
        metadata: { url: response.url, title: page.title, truncated: page.truncated }
      };
    }
  }
];

export const WEB_TOOL_NAMES = new Set(webTools.map(tool => tool.name));
export { searchProvider };
