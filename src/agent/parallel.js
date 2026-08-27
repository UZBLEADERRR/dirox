/**
 * Which tool calls may run at the same time.
 *
 * A model that asks for four files in one turn was, until now, made to wait
 * for each one in turn. Nothing about those four reads depends on the others;
 * the sequence was an accident of the loop being written as a `for`.
 *
 * The saving is wall-clock, not tokens, and it is worth being honest about
 * that: running four reads together does not make the run cheaper, it makes it
 * finish sooner. On a long task that is most of what a person experiences.
 *
 * The rule is narrow on purpose. Only calls that cannot change anything run
 * together; everything else runs alone, in the order the model asked for it.
 * Two writes to the same file, or a write and a read of it, have an order that
 * matters even when the model did not think about it — and a scheduler that
 * has to reason about which pairs conflict is a scheduler that will eventually
 * get one wrong. Read-only calls have no such pairs at all.
 *
 * Order is preserved regardless: results go back to the model in the order it
 * asked for them, whatever order they finished in.
 */

import { effectiveRisk } from './tools/index.js';
import { RISK } from './permissions.js';

/**
 * How many calls may be in flight at once.
 *
 * Four is chosen against provider rate limits rather than against the machine:
 * a burst of sixteen concurrent requests is how a run gets a 429, and a 429
 * costs more time than the serialisation saved.
 */
export const MAX_PARALLEL = 4;

/**
 * Tools that must run alone even though they cannot change a file.
 *
 * `delegate` spawns a whole run of its own. Two of those in flight would be
 * two agents sharing one budget object and one workspace, which is a
 * different feature with different risks — worth having, not worth having
 * by accident.
 */
const ALWAYS_ALONE = new Set(['delegate']);

/**
 * Split one turn's tool calls into groups that may run together.
 *
 * Consecutive read-only calls are grouped; anything else becomes a group of
 * one. Grouping only consecutive calls keeps the model's ordering intact: if
 * it asked to read, then write, then read, the second read still happens after
 * the write.
 *
 * @param {Array<{name:string, arguments:object}>} calls
 * @param {object} ctx  passed to a tool's `riskFor`
 * @returns {Promise<Array<Array<object>>>}
 */
export async function planBatch(calls, ctx = {}, { maxParallel = MAX_PARALLEL } = {}) {
  const risks = await Promise.all(calls.map(call => effectiveRisk(call, ctx)));

  const groups = [];
  let current = [];

  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };

  calls.forEach((call, index) => {
    const together = risks[index] === RISK.SAFE && !ALWAYS_ALONE.has(call.name);
    if (!together) {
      flush();
      groups.push([call]);
      return;
    }
    current.push(call);
    if (current.length >= maxParallel) flush();
  });

  flush();
  return groups;
}

export { ALWAYS_ALONE };
