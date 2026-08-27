/**
 * Fetching a URL the agent chose.
 *
 * This is the most dangerous tool in the product, and it does not look like
 * it. Everything else the agent runs is bounded by the workspace or by an API
 * we hold the credentials for. This one takes an address decided by a model —
 * which may have read that address out of a file in the user's repository, or
 * out of a web page it fetched a moment ago — and makes our server go there.
 *
 * The attack is server-side request forgery, and on a platform like this it is
 * not theoretical: our container can reach things the internet cannot. The
 * cloud metadata endpoint at 169.254.169.254 hands out credentials to anybody
 * inside the network who asks. `localhost` is our own API, holding a service
 * role key. A private range is whatever else the deployment runs.
 *
 * So three rules, and each one closes a specific hole:
 *
 *   1. Only http and https. `file://` reads the disk; `gopher://` and friends
 *      can be used to speak other protocols entirely.
 *   2. The address is resolved before the request, and every resolved IP is
 *      checked. A hostname that resolves to 127.0.0.1 is the standard way past
 *      a name-based blocklist, and one that resolves to two addresses is the
 *      standard way past a check that only looks at the first.
 *   3. Redirects are followed by hand, and each hop is checked the same way.
 *      An allowed host that redirects to the metadata endpoint is the same
 *      attack wearing a hat.
 */

import { lookup } from 'node:dns/promises';
import { badRequest, upstreamFailed } from '../core/errors.js';

/** How long any one request may take. */
const TIMEOUT_MS = 15_000;

/** How much of a response is read before we stop. */
const MAX_BYTES = 4 * 1024 * 1024;

/** How many redirects are followed. */
const MAX_HOPS = 4;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Is this address inside our own network?
 *
 * Written out rather than pulled from a library so every range is visible and
 * can be argued with. IPv6 is included because `::ffff:127.0.0.1` and `::1`
 * are the same holes with different syntax.
 */
export function isPrivateAddress(address) {
  const ip = String(address || '').toLowerCase();

  // IPv4-mapped IPv6 addresses are IPv4 addresses wearing a hat.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const target = mapped ? mapped[1] : ip;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(target)) {
    const parts = target.split('.').map(Number);
    if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;

    if (a === 0) return true;                                  // "this network"
    if (a === 10) return true;                                 // private
    if (a === 127) return true;                                // loopback
    if (a === 169 && b === 254) return true;                   // link-local, and cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;          // private
    if (a === 192 && b === 168) return true;                   // private
    if (a === 192 && b === 0) return true;                     // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
    if (a === 100 && b >= 64 && b <= 127) return true;         // carrier-grade NAT
    if (a >= 224) return true;                                 // multicast and reserved
    return false;
  }

  // IPv6.
  if (target === '::' || target === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(target)) return true;          // unique local
  if (/^fe[89ab][0-9a-f]:/.test(target)) return true;          // link-local
  if (/^ff/.test(target)) return true;                         // multicast
  return false;
}

/** Is this already an address rather than a name? */
export function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Check one URL, resolving its hostname.
 *
 * @returns {Promise<URL>} the parsed URL, if it is safe to request
 */
export async function assertPublicUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw badRequest(`"${String(input).slice(0, 120)}" is not a URL.`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw badRequest(`Only http and https can be fetched, not ${url.protocol.replace(':', '')}.`);
  }

  // Credentials in a URL are either a mistake or an attempt to reach something
  // that needs them, and neither is a thing to do on the user's behalf.
  if (url.username || url.password) {
    throw badRequest('A URL with a username or password in it will not be fetched.');
  }

  /*
     A literal address is checked as itself.

     `new URL('http://[::1]/')` keeps the brackets in `hostname`, and
     `dns.lookup('[::1]')` fails — so a bracketed IPv6 literal was being
     refused with "could not be resolved", which is the right outcome for the
     wrong reason and would have read as a network problem rather than a
     blocked address.
  */
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) {
      throw badRequest(`${url.hostname} is a private address, so it will not be fetched.`);
    }
    return url;
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw badRequest(`${url.hostname} could not be resolved.`);
  }

  // Every address, not the first: a host that resolves to a public address and
  // a private one is the standard way past a check that stops at one.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw badRequest(`${url.hostname} resolves to a private address (${address}), so it will not be fetched.`);
    }
  }

  return url;
}

/**
 * Fetch a public URL, following redirects one checked hop at a time.
 *
 * @param {string} input
 * @param {{method?:string, body?:string, headers?:object, timeoutMs?:number, maxBytes?:number}} [options]
 * @returns {Promise<{url:string, status:number, contentType:string, body:Buffer, truncated:boolean}>}
 */
export async function safeFetch(input, { method = 'GET', body: payload, headers = {}, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  let target = await assertPublicUrl(input);

  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(target, {
        method,
        body: payload,
        headers: {
          // Named honestly. A crawler that lies about who it is deserves
          // whatever a site does about it.
          'user-agent': 'DiroxCode/2.0 (+https://github.com/UZBLEADERRR/dirox)',
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'en',
          ...headers
        },
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw upstreamFailed(`${target.hostname} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
      throw upstreamFailed(`${target.hostname} could not be reached: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === MAX_HOPS) throw upstreamFailed('Too many redirects.');
      // A redirected POST is not replayed. Sending the same body to a
      // different host because it asked is how a redirect becomes a way to
      // post the user's data somewhere they did not choose.
      if (method !== 'GET' && method !== 'HEAD') {
        throw upstreamFailed(`${target.hostname} redirected a ${method}, which is not followed.`);
      }
      // Checked again, from scratch. An allowed host redirecting to the
      // metadata endpoint is the same attack with an extra step.
      target = await assertPublicUrl(new URL(location, target).toString());
      continue;
    }

    // Read with a ceiling rather than trusting content-length: a server can
    // say one thing and send another, and a 2GB body would end the container.
    const chunks = [];
    let size = 0;
    let truncated = false;

    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          chunks.push(Buffer.from(value.subarray(0, value.length - (size - maxBytes))));
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }

    return {
      url: target.toString(),
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body: Buffer.concat(chunks),
      truncated
    };
  }

  throw upstreamFailed('Too many redirects.');
}

export { MAX_BYTES, MAX_HOPS, TIMEOUT_MS };
