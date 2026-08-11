// LLM-led dialogue orchestrator (P2-HUMANIZE §1): context → structured plan →
// deterministic executor, with a single never-repeat regenerate. THROWS on LLM
// failure — the engine catches and runs the classic flow, so the bot can never
// go silent (the fallback contract deliberately inverts the decorative
// generate() path, which degrades to mock text).
import { buildLlmRequest } from './context.js';
import { coercePlan } from './schema.js';
import { executePlan, applyVariation } from './executor.js';
import { VARY_HINT } from './prompt.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One structured call with a single retry. Observed failures on the free Gemini
 * tier are dominated by a fast (~0.1s) `http 429` under bursts, and the
 * occasional truncated/blocked response — all transient. A brief backoff + one
 * fresh attempt recovers almost all of them, which beats dumping the patient to
 * the classic "I didn't understand" menu. If BOTH attempts fail it throws, and
 * the engine falls back to classic (the bot still never goes silent).
 */
async function callStructured(provider, request) {
  try {
    return await provider.generateStructured(request);
  } catch (first) {
    await sleep(600);
    try {
      return await provider.generateStructured(request);
    } catch {
      throw first;
    }
  }
}

/**
 * @param {object} ctx  the engine turn context ({inbound, text, clinic, convo,
 *                      lang, store, provider, config, now})
 * @returns {Promise<object>} classic route() result shape
 * @throws when the provider fails/times out (caller falls back to classic)
 */
export async function handleLlmTurn(ctx) {
  const request = await buildLlmRequest(ctx);
  // Snapshot the pre-turn state so a regenerate re-executes from a clean base
  // instead of mutating state the discarded first pass already touched.
  const snapshot = ctx.convo.state ? structuredClone(ctx.convo.state) : null;
  const restore = () => {
    ctx.convo.state = snapshot ? structuredClone(snapshot) : null;
  };

  // request carries { system, messages, schema } — schema is the per-tenant
  // ENUM-constrained variant (buildLlmRequest), which prevents flash models
  // from looping on the specialty string field.
  const plan = coercePlan(await callStructured(ctx.provider, request));
  let result = await executePlan(ctx, plan);

  if (result.__repeat) {
    // Never-repeat policy: one regenerate with a vary hint, else the fallback
    // variation bank (different angle + human offer).
    restore();
    try {
      const retryPlan = coercePlan(
        await ctx.provider.generateStructured({
          ...request,
          system: request.system + VARY_HINT,
        })
      );
      const second = await executePlan(ctx, retryPlan);
      result = second.__repeat ? applyVariation(ctx, second) : second;
    } catch {
      // Re-run the original plan on the restored state, then vary the reply so
      // the patient never sees the same bubble twice.
      result = applyVariation(ctx, await executePlan(ctx, plan));
    }
  }
  delete result.__repeat;
  return result;
}
