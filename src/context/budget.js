/**
 * Token Budget Manager.
 *
 * Every task is given a cost budget in micro-USD. This module converts that
 * into concrete limits — how much context may be retrieved, how long the output
 * may be, how much tool output survives — and adjusts them as the budget is
 * spent.
 *
 * The agent can read its own remaining budget, which is what lets it degrade
 * deliberately (compress, drop to a cheaper model, stop retrying) instead of
 * failing when the money runs out.
 */

import { systemSetting } from '../ai/catalog.js';
import { estimateCost } from '../ai/pricing.js';
import { levelIndex } from '../ai/router.js';

const DEFAULT_CONTEXT_BUDGET = {
  level0: 4000, level1: 12_000, level2: 32_000, level3: 80_000, level4: 160_000,
  reserve_output: 0.25
};

export class TokenBudget {
  /**
   * @param {{budgetMicros:number, spentMicros?:number, level?:string}} options
   */
  constructor({ budgetMicros = 100_000, spentMicros = 0, level = 'level1' } = {}) {
    this.budgetMicros = Math.max(0, budgetMicros);
    this.spentMicros = Math.max(0, spentMicros);
    this.level = level;
    this.history = [];
  }

  get remainingMicros() { return Math.max(0, this.budgetMicros - this.spentMicros); }
  get usedRatio() { return this.budgetMicros ? Math.min(1, this.spentMicros / this.budgetMicros) : 1; }
  get exhausted() { return this.remainingMicros <= 0; }

  /**
   * How constrained the agent should behave.
   *  comfortable — under half spent
   *  tightening  — over half; compress context, prefer cheaper models
   *  critical    — over 85%; finish or stop, no speculative work
   */
  get pressure() {
    const ratio = this.usedRatio;
    if (ratio < 0.5) return 'comfortable';
    if (ratio < 0.85) return 'tightening';
    return 'critical';
  }

  record(costMicros, label = '') {
    this.spentMicros += Math.max(0, costMicros);
    this.history.push({ costMicros, label, at: Date.now() });
    if (this.history.length > 100) this.history.shift();
    return this.remainingMicros;
  }

  /** Would this call fit? Used before spending, not after. */
  canAfford(model, { inputTokens, maxOutputTokens }) {
    const estimate = estimateCost(model, { inputTokens, maxOutputTokens });
    return { affordable: estimate <= this.remainingMicros, estimateMicros: estimate };
  }

  /**
   * Concrete limits for the next model call.
   * @returns {Promise<{contextTokens:number, outputTokens:number, maxFiles:number, toolOutputChars:number, retrievalDepth:number}>}
   */
  async limits({ model, level = this.level } = {}) {
    const configured = await systemSetting('context.budget', DEFAULT_CONTEXT_BUDGET);
    const base = configured[level] ?? DEFAULT_CONTEXT_BUDGET[level] ?? 12_000;

    // Scale down as the budget is consumed. At 'critical' the agent gets barely
    // more than the essentials, which is the correct behaviour: finish, or stop.
    const pressureFactor = { comfortable: 1, tightening: 0.6, critical: 0.3 }[this.pressure];

    // Never plan a context larger than the model can actually hold, keeping a
    // reserve for the response.
    const reserve = configured.reserve_output ?? 0.25;
    const modelCeiling = model
      ? Math.floor(model.context_window * (1 - reserve))
      : base;

    const contextTokens = Math.max(1000, Math.floor(Math.min(base * pressureFactor, modelCeiling)));

    // What the remaining money can actually pay for, if that is the tighter
    // constraint.
    let affordableTokens = contextTokens;
    if (model && Number(model.input_price_micros) > 0) {
      affordableTokens = Math.floor((this.remainingMicros * 0.6) / (Number(model.input_price_micros) / 1_000_000));
    }

    const finalContext = Math.max(800, Math.min(contextTokens, affordableTokens));
    const depth = levelIndex(level);

    return {
      contextTokens: finalContext,
      outputTokens: Math.max(256, Math.floor((model?.max_output ?? 4096) * pressureFactor)),
      maxFiles: Math.max(2, Math.round((4 + depth * 3) * pressureFactor)),
      retrievalDepth: Math.max(8, Math.round((20 + depth * 10) * pressureFactor)),
      toolOutputChars: Math.max(800, Math.round(6000 * pressureFactor)),
      historyMessages: Math.max(4, Math.round((8 + depth * 4) * pressureFactor)),
      pressure: this.pressure
    };
  }

  /** A short line the agent sees, so it can reason about its own constraint. */
  describe() {
    const usd = micros => `$${(micros / 1_000_000).toFixed(3)}`;
    return `Budget ${usd(this.budgetMicros)} · used ${usd(this.spentMicros)} · remaining ${usd(this.remainingMicros)} (${this.pressure}).`;
  }

  toJSON() {
    return {
      budgetMicros: this.budgetMicros,
      spentMicros: this.spentMicros,
      remainingMicros: this.remainingMicros,
      usedRatio: Number(this.usedRatio.toFixed(3)),
      pressure: this.pressure
    };
  }
}

/**
 * Default budget for a task, scaled by complexity.
 * An administrator sets the base; harder tasks are allowed proportionally more.
 */
export async function defaultBudgetFor(level) {
  const defaults = await systemSetting('agent.defaults', { default_budget_micros: 100_000 });
  const base = defaults.default_budget_micros ?? 100_000;
  const multiplier = [0.15, 0.5, 1, 2.5, 5][levelIndex(level)] ?? 1;
  return Math.round(base * multiplier);
}

export { DEFAULT_CONTEXT_BUDGET };
