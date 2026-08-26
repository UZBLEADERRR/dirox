/**
 * Cost arithmetic.
 *
 * Prices are stored per million tokens in micro-USD so all of this is integer
 * maths — no floating point drift accumulating across thousands of calls.
 *
 *   1 micro-USD = $0.000001
 *   $3.00 per 1M input tokens  ->  input_price_micros = 3_000_000
 */

const PER_MILLION = 1_000_000;

/**
 * @param {object} model  a row from `models`
 * @param {{inputTokens?:number, outputTokens?:number, cachedInputTokens?:number, reasoningTokens?:number}} usage
 * @returns {number} cost in micro-USD, rounded up so we never under-report
 */
export function costOf(model, usage = {}) {
  if (!model) return 0;

  const input = Math.max(0, usage.inputTokens || 0);
  const cached = Math.min(input, Math.max(0, usage.cachedInputTokens || 0));
  const fresh = input - cached;
  // Reasoning tokens are billed at the output rate by every provider that
  // reports them separately.
  const output = Math.max(0, usage.outputTokens || 0) + Math.max(0, usage.reasoningTokens || 0);

  const cachedRate = model.cached_input_price_micros ?? model.input_price_micros;

  const total =
    (fresh * Number(model.input_price_micros || 0)) / PER_MILLION +
    (cached * Number(cachedRate || 0)) / PER_MILLION +
    (output * Number(model.output_price_micros || 0)) / PER_MILLION;

  return Math.ceil(total);
}

/**
 * Predict the cost of a call before making it, so the budget engine can refuse
 * a request that cannot fit rather than discovering it afterwards.
 */
export function estimateCost(model, { inputTokens = 0, maxOutputTokens = 0, cacheHitRatio = 0 } = {}) {
  return costOf(model, {
    inputTokens,
    cachedInputTokens: Math.round(inputTokens * Math.min(1, Math.max(0, cacheHitRatio))),
    outputTokens: maxOutputTokens
  });
}

/**
 * Token estimation without a tokenizer.
 *
 * Deliberately conservative: it over-estimates slightly so a budget check errs
 * towards refusing rather than overspending. Real usage always comes back from
 * the provider and replaces this number in the ledger.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const source = typeof text === 'string' ? text : JSON.stringify(text);

  // Code averages closer to 3 characters per token than prose's ~4, because of
  // punctuation density and identifier splitting.
  const characters = source.length;
  const whitespace = (source.match(/\s/g) || []).length;
  const symbols = (source.match(/[^\w\s]/g) || []).length;
  const density = (symbols + 1) / (characters + 1);
  const divisor = density > 0.12 ? 3.0 : 3.8;

  return Math.ceil(characters / divisor) + Math.ceil(whitespace * 0.02);
}

/** Estimate the token cost of a full message array, including role overhead. */
export function estimateMessageTokens(messages = []) {
  let total = 0;
  for (const message of messages) {
    total += 4;   // role + delimiters
    if (typeof message.content === 'string') total += estimateTokens(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') total += estimateTokens(part.text);
        else if (part.type === 'image_url' || part.type === 'image') total += 800;  // typical vision tile
        else total += estimateTokens(part);
      }
    }
    if (message.tool_calls) total += estimateTokens(message.tool_calls);
  }
  return total + 3;
}

export function microsToUsd(micros) { return Number(micros || 0) / PER_MILLION; }
export function usdToMicros(usd) { return Math.round(Number(usd || 0) * PER_MILLION); }
export function centsToMicros(cents) { return Math.round(Number(cents || 0) * 10_000); }
export function microsToCents(micros) { return Math.round(Number(micros || 0) / 10_000); }

export { PER_MILLION };
