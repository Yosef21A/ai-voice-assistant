// LLM-led dialogue orchestrator (P2-HUMANIZE §1): context → structured plan →
// deterministic executor, with a single never-repeat regenerate. THROWS on LLM
// failure — the engine catches and runs the classic flow, so the bot can never
// go silent (the fallback contract deliberately inverts the decorative
// generate() path, which degrades to mock text).
import { buildLlmRequest } from './context.js';
import { RESPONSE_SCHEMA, coercePlan } from './schema.js';
import { executePlan, applyVariation } from './executor.js';
import { VARY_HINT } from './prompt.js';

/**
 * @param {object} ctx  the engine turn context ({inbound, text, clinic, convo,
 *                      lang, store, provider, config, now})
 * @returns {Promise<object>} classic route() result shape
 * @throws when the provider fails/times out (caller falls back to classic)
 */
export async function handleLlmTurn(ctx) {
  const request = await buildLlmRequest(ctx);
  const plan = coercePlan(
    await ctx.provider.generateStructured({ ...request, schema: RESPONSE_SCHEMA })
  );
  let result = executePlan(ctx, plan);

  if (result.__repeat) {
    // Never-repeat policy: one regenerate with a vary hint, else the fallback
    // variation bank (different angle + human offer).
    try {
      const retryPlan = coercePlan(
        await ctx.provider.generateStructured({
          ...request,
          system: request.system + VARY_HINT,
          schema: RESPONSE_SCHEMA,
        })
      );
      const second = executePlan(ctx, retryPlan);
      result = second.__repeat ? applyVariation(ctx, second) : second;
    } catch {
      result = applyVariation(ctx, result);
    }
  }
  delete result.__repeat;
  return result;
}
