// THE BRAIN CHAIN — flash-lite → 3-flash → cerebras → groq → classic.
//
// THE RULE THAT THIS FILE EXISTS FOR, quoted from the doctrine because it is
// the root cause of the founder's "bad replies" verdict:
//
//   "Rotation on 429/quota — quota exhaustion must trigger the NEXT provider,
//    never silent classic degradation."
//
// The chat side already had this failure: an exhausted free-tier key made every
// LLM turn fall back to the scripted engine, silently, and the only symptom was
// a bot that had got worse. So here: every rotation is LOGGED, the answering
// provider is NAMED in the per-turn waterfall, and classic is reached only as
// the last explicit link — never as an unnoticed default.
//
// WHAT ROTATES AND WHAT DOES NOT:
//   • A failure BEFORE the provider has produced a single token rotates to the
//     next link, on the same turn, and the caller never knows.
//   • A failure AFTER text has already been spoken does NOT rotate. Half a
//     sentence in one voice followed by a different answer is worse than a
//     short answer: the turn ends with what was said, the failure is noted, and
//     the NEXT turn starts further down the chain.
//   • A CALLER abort (barge-in, a speculative turn overtaken by the real one)
//     is not a failure at all and is re-thrown untouched — mislabelling it
//     would bench a healthy provider every time a caller interrupted.
import { createGeminiTextLlm, GEMINI_PRIMARY_MODEL, GEMINI_SECONDARY_MODEL } from './geminiText.js';
import { createOpenAiCompatLlm } from './openaiCompat.js';
import { createClassicLlm } from './classic.js';
import { LlmError, isLlmError, isRotatable } from './http.js';
import {
  isLlmBreakerOpen,
  noteLlmFailure,
  noteLlmOk,
  DEFAULT_LLM_BREAKER_THRESHOLD,
  DEFAULT_LLM_BREAKER_COOLDOWN_MS,
} from './breaker.js';

export { LlmError, isLlmError, isRotatable } from './http.js';
export {
  noteLlmFailure,
  noteLlmOk,
  isLlmBreakerOpen,
  resetLlmBreakers,
  llmBreakerStats,
  DEFAULT_LLM_BREAKER_THRESHOLD,
  DEFAULT_LLM_BREAKER_COOLDOWN_MS,
} from './breaker.js';
export { createGeminiTextLlm } from './geminiText.js';
export { createOpenAiCompatLlm } from './openaiCompat.js';
export { createClassicLlm } from './classic.js';

/** The doctrine order, P0-measured. `classic` is always last and always there. */
export const LLM_ORDER = Object.freeze([GEMINI_PRIMARY_MODEL, GEMINI_SECONDARY_MODEL, 'cerebras', 'groq', 'classic']);

/**
 * Which links could run at all, given the keys present. Exported because "why
 * did classic answer?" must be answerable without reading the code.
 */
export function availableLlm(config = {}) {
  const out = [];
  if (String(config.geminiApiKey || '')) out.push(GEMINI_PRIMARY_MODEL, GEMINI_SECONDARY_MODEL);
  if (String(config.cerebrasApiKey || '')) out.push('cerebras');
  if (String(config.groqApiKey || '')) out.push('groq');
  out.push('classic'); // no key, no network, no quota — it is always there
  return LLM_ORDER.filter((n) => out.includes(n));
}

/**
 * @param {object} p
 * @param {object} p.config
 * @param {object} p.clinic
 * @param {object} [p.store]        the classic link needs it
 * @param {object} [p.bus]          …and so does its event-layer parity
 * @param {object} [p.convo]        the inbox conversation the call rides on
 * @param {Array<object>} [p.tools] brain/tools.js declarations (NOT forked)
 * @param {string} [p.lang]
 * @param {string} [p.patientWaId]
 * @param {Function} [p.fetchImpl]  injected everywhere; tests never hit a socket
 * @param {Function} [p.now]
 * @param {Function} [p.logger]
 * @param {Function} [p.engineFactory]
 * @param {Function} [p.onClassicResult]
 * @param {object} [p.links]        { name: {provider, stream} } — tests inject
 * @returns {{streamTurn:Function, get provider():string, order:string[],
 *   noteResult:Function, stats:Function}}
 */
export function createLlmChain({
  config = {},
  clinic,
  store,
  bus,
  convo,
  tools,
  lang = 'ar',
  patientWaId,
  fetchImpl,
  now,
  logger,
  engineFactory,
  onClassicResult,
  links: injected,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const clock = typeof now === 'function' ? now : () => new Date();
  const order = injected ? Object.keys(injected) : availableLlm(config);
  const breakerOpts = {
    threshold: Number(config.voiceLlmBreakerThreshold) || DEFAULT_LLM_BREAKER_THRESHOLD,
    cooldownMs: Number(config.voiceLlmBreakerCooldownMs) || DEFAULT_LLM_BREAKER_COOLDOWN_MS,
  };

  /** Built lazily: a link nobody reaches costs nothing, not even a constructor. */
  const built = new Map();
  const counts = { turns: 0, rotations: 0, byProvider: {} };
  let answering = order[0] || 'classic';
  /**
   * STICKY CLASSIC (review decision). Once the scripted engine has answered a
   * turn, it owns the REST of this call.
   *
   * Without this the call ping-pongs: the engine collects a name and a day into
   * ITS booking state, the next turn goes back to a recovered LLM which knows
   * nothing about that state and starts its own two-phase gate, and the caller
   * is asked the same questions twice by two different mechanisms — with two
   * half-finished bookings behind them. One conversation, one gate. The cost is
   * that a call which briefly lost its brain stays on the scripted flow to the
   * end, which is a worse VOICE and a correct BOOKING; that is the right trade.
   */
  let sticky = false;

  function link(name) {
    if (injected) return injected[name] || null;
    if (built.has(name)) return built.get(name);
    let impl = null;
    try {
      if (name === GEMINI_PRIMARY_MODEL || name === GEMINI_SECONDARY_MODEL) {
        impl = createGeminiTextLlm({
          apiKey: config.geminiApiKey,
          model: name,
          tools,
          fetchImpl,
          logger: log,
        });
      } else if (name === 'cerebras' || name === 'groq') {
        impl = createOpenAiCompatLlm({
          provider: name,
          apiKey: name === 'cerebras' ? config.cerebrasApiKey : config.groqApiKey,
          tools,
          fetchImpl,
          logger: log,
        });
      } else if (name === 'classic') {
        impl = createClassicLlm({
          clinic,
          store,
          bus,
          convo,
          config,
          lang,
          patientWaId,
          now: clock,
          logger: log,
          engineFactory,
          onResult: onClassicResult,
        });
      }
    } catch (err) {
      // A link that refuses to construct (missing key, bad provider name) is a
      // configuration fact, not an outage. Remember the null and move on.
      log(`[voice-cascade] LLM link ${name} unavailable: ${err?.message || err}`);
      impl = null;
    }
    built.set(name, impl);
    return impl;
  }

  return {
    /** The provider that answered (or is answering) the current turn. */
    get provider() {
      return answering;
    },
    order,

    /**
     * Run ONE turn through the chain.
     *
     * @param {object} p
     * @param {string} p.system
     * @param {Array<object>} p.messages neutral history
     * @param {AbortSignal} [p.signal]
     * @yields {{type:'text',delta}|{type:'toolCall',call}|{type:'done',usage,provider}}
     */
    async *streamTurn({ system = '', messages = [], signal } = {}) {
      counts.turns += 1;
      const at = clock().getTime ? clock().getTime() : Date.now();
      let lastErr = null;
      // Once classic owns the call it answers every turn — no rotation back to
      // a recovered vendor mid-conversation (see `sticky`).
      const links = sticky ? ['classic'] : order;

      for (let i = 0; i < links.length; i += 1) {
        const name = links[i];
        const impl = link(name);
        if (!impl) continue;
        // The breaker never benches the last link: something has to answer.
        if (name !== 'classic' && isLlmBreakerOpen(name, { ...breakerOpts, at })) {
          log(`[voice-cascade] LLM breaker OPEN for ${name} — skipping it this turn`);
          continue;
        }

        answering = impl.provider || name;
        let spoke = false;
        try {
          /**
           * A 200 THAT SAYS NOTHING IS A FAILURE, not a turn.
           *
           * Found in review: a provider that streamed a well-formed response
           * with no text and no tool call — a safety refusal, a finishReason
           * with an empty candidate, a truncated generation — was booked as a
           * success. The caller heard silence, the chain never rotated, and the
           * breaker never counted it. So `done` is HELD until we know something
           * was produced, and a mute stream falls into the rotation path below
           * exactly like a 429 would.
           */
          let doneEv = null;
          for await (const ev of impl.stream({ system, messages, signal })) {
            if (ev?.type === 'done') {
              doneEv = ev;
              continue;
            }
            if (ev?.type === 'text' && ev.delta) spoke = true;
            if (ev?.type === 'toolCall') spoke = true;
            yield ev;
          }
          if (!spoke) {
            throw new LlmError(`${name} produced no text and no tool call`, { provider: name, kind: 'empty' });
          }
          counts.byProvider[answering] = (counts.byProvider[answering] || 0) + 1;
          noteLlmOk(name);
          if (name === 'classic') sticky = true;
          yield {
            ...(doneEv || { type: 'done', usage: { tokensIn: 0, tokensOut: 0 } }),
            provider: answering,
          };
          return;
        } catch (err) {
          // A caller abort is OUR cancellation, not a vendor failure. Re-thrown
          // untouched so a barge-in never benches a healthy model.
          if (signal?.aborted) throw err;
          lastErr = err;
          const b = noteLlmFailure(name, { threshold: breakerOpts.threshold, at });
          if (b.justOpened) {
            log(`[voice-cascade] LLM BREAKER OPEN for ${name} after ${b.failures} failures`);
          }
          if (spoke) {
            // Half a sentence is already in the caller's ear. Ending the turn
            // short beats answering it twice in two different voices.
            log(`[voice-cascade] ${name} died mid-answer (${err?.message || err}) — ending this turn early`);
            yield { type: 'done', usage: { tokensIn: 0, tokensOut: 0 }, provider: answering, degraded: true };
            return;
          }
          if (!isLlmError(err) || isRotatable(err) || i < links.length - 1) {
            counts.rotations += 1;
            log(
              `[voice-cascade] LLM ${name} failed (${err?.message || err}) — rotating to ` +
                `${links[i + 1] || 'nothing left'}`
            );
            continue;
          }
          throw err;
        }
      }

      // Nothing answered. This is only reachable if even `classic` threw, which
      // it is written never to do — so it is a bug, and it is reported as one
      // rather than swallowed into silence on a live call.
      throw lastErr || new Error('no LLM provider answered this turn');
    },

    /** Ops hook: a turn's outcome, from the orchestrator's point of view. */
    noteResult({ ok = true, provider } = {}) {
      const name = provider || answering;
      if (ok) noteLlmOk(name);
      else noteLlmFailure(name, { threshold: breakerOpts.threshold, at: Date.now() });
    },

    /** True once the scripted engine has taken the call over for good. */
    get classicOwned() {
      return sticky;
    },

    stats() {
      return { provider: answering, order, classicOwned: sticky, ...counts };
    },
  };
}

export default createLlmChain;
