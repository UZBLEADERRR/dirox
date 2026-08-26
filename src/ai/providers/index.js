/**
 * Adapter registry.
 *
 * Adding a provider means adding an adapter here, not touching the gateway.
 * `openrouter` speaks the OpenAI format, so it reuses that adapter with
 * different headers.
 */

import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as google from './google.js';
import { badRequest } from '../../core/errors.js';

const ADAPTERS = { openai, openrouter: openai, anthropic, google };

export function adapterFor(provider) {
  const adapter = ADAPTERS[provider?.adapter];
  if (!adapter) throw badRequest(`No adapter is registered for provider type "${provider?.adapter}"`);
  return adapter;
}

export function knownAdapters() { return Object.keys(ADAPTERS); }

export { openai, anthropic, google };
