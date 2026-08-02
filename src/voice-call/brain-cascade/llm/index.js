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
  noteLlmTtft,
  llmTtftClamp,
  DEFAULT_LLM_BREAKER_THRESHOLD,
  DEFAULT_LLM_BREAKER_COOLDOWN_MS,
  DEFAULT_TTFT_CLAMP_MS,
} from './breaker.js';

export { LlmError, isLlmError, isRotatable } from './http.js';
export {
  noteLlmFailure,
  noteLlmOk,
  noteLlmTtft,
  llmTtftClamp,
  llmTtftStats,
  isLlmBreakerOpen,
  resetLlmBreakers,
  llmBreakerStats,
  DEFAULT_LLM_BREAKER_THRESHOLD,
  DEFAULT_LLM_BREAKER_COOLDOWN_MS,
  DEFAULT_TTFT_CLAMP_MS,
  TTFT_WINDOW,
  TTFT_PROBE_EVERY,
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

/** Longest slice of a vendor's own error body we put in a rotation log line. */
const MAX_LOGGED_DETAIL = 200;

/**
 * THE VENDOR'S OWN WORDS, safe to log.
 *
 * A rotation line that says only `returned HTTP 400` is the difference between
 * "the model rejected our request payload, here is the field" and a night of
 * guessing — and it cost exactly that on a rehearsal call, where both Gemini
 * links 400'd, `classic` took the call sticky, and the caller was answered with
 * «ما فهمتش قصدك» for the rest of the booking. http.js already captures the
 * body onto the error; this only prints it.
 *
 * `key=` is redacted because the Gemini key rides in the URL (geminiText.js) and
 * a vendor is entitled to echo the request back inside its error.
 *
 * @param {*} err
 * @returns {string} '' or ': <detail>'
 */
export function describeLlmDetail(err) {
  const raw = err?.detail;
  if (!raw) return '';
  const flat = String(raw)
    .replace(/key=[^&"'\s]+/gi, 'key=REDACTED')
    .replace(/\s+/g, ' ')
    .trim();
  return flat ? `: ${flat.slice(0, MAX_LOGGED_DETAIL)}` : '';
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
  /**
   * V8-D2 §2 — the soft clamp on a provider that is up but slow. A deliberate 0
   * (or 'off') means NEVER clamp and must survive: `|| DEFAULT` would turn it
   * back on (review minor 6). llmTtftClamp treats any non-positive value as off.
   */
  const clampMs = Number.isFinite(Number(config.voiceCascadeTtftClampMs))
    ? Number(config.voiceCascadeTtftClampMs)
    : DEFAULT_TTFT_CLAMP_MS;

  /** Built lazily: a link nobody reaches costs nothing, not even a constructor. */
  const built = new Map();
  const counts = { turns: 0, rotations: 0, byProvider: {}, clamped: 0, prewarmed: 0 };
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
      // a recovered vendor mid-conversation (see `sticky`). A COPY, because the
      // forced-probe path (below) splices into it and `order` is per-call state
      // shared across turns.
      const links = sticky ? ['classic'] : [...order];
      // Vendors skipped THIS turn purely for being slow, and whether anything
      // actually FAILED. The distinction is the whole of review major 5: reaching
      // classic because everyone is merely cooling is not an outage, and must not
      // stick the call to the scripted engine for the rest of the call.
      const clampSkips = [];
      let hadRealFailure = false;

      /**
       * Run ONE link to completion. Yields its events; RETURNS a small verdict
       * the loop reads via `yield*`. Extracted so the forced cooling-probe can
       * reuse the exact same attempt (TTFT measurement, empty-stream rule,
       * mid-answer degrade) rather than a second, drifting copy of it.
       * @returns {{done?:boolean, skipped?:boolean, err?:Error}}
       */
      async function* attempt(name) {
        const impl = link(name);
        if (!impl) return { skipped: true };
        answering = impl.provider || name;
        let spoke = false;
        // TTFT IS MEASURED HERE, not in the orchestrator: this is the only place
        // that knows when the request left and which link answered it.
        const startedAt = Date.now();
        let ttftNoted = false;
        try {
          // A 200 THAT SAYS NOTHING IS A FAILURE, not a turn: `done` is HELD
          // until something is produced, so a mute stream rotates like a 429.
          let doneEv = null;
          for await (const ev of impl.stream({ system, messages, signal })) {
            if (ev?.type === 'done') {
              doneEv = ev;
              continue;
            }
            if (ev?.type === 'text' && ev.delta) spoke = true;
            if (ev?.type === 'toolCall') spoke = true;
            if (spoke && !ttftNoted) {
              ttftNoted = true;
              noteLlmTtft(name, Date.now() - startedAt);
            }
            yield ev;
          }
          if (!spoke) {
            throw new LlmError(`${name} produced no text and no tool call`, { provider: name, kind: 'empty' });
          }
          counts.byProvider[answering] = (counts.byProvider[answering] || 0) + 1;
          noteLlmOk(name);
          // STICKY ONLY WHEN CLASSIC IS A GENUINE FALLBACK (review major 5).
          // Classic is reachable now only after a real failure (the forced probe
          // guards the pure-clamp path), so this no longer demotes a call for a
          // transient slow window.
          if (name === 'classic') sticky = true;
          yield { ...(doneEv || { type: 'done', usage: { tokensIn: 0, tokensOut: 0 } }), provider: answering };
          return { done: true };
        } catch (err) {
          // A caller abort is OUR cancellation, not a vendor failure. Re-thrown
          // untouched so a barge-in never benches a healthy model.
          if (signal?.aborted) throw err;
          const b = noteLlmFailure(name, { threshold: breakerOpts.threshold, at });
          if (b.justOpened) log(`[voice-cascade] LLM BREAKER OPEN for ${name} after ${b.failures} failures`);
          if (spoke) {
            // Half a sentence is already in the caller's ear. Ending the turn
            // short beats answering it twice in two different voices.
            log(`[voice-cascade] ${name} died mid-answer (${err?.message || err}) — ending this turn early`);
            yield { type: 'done', usage: { tokensIn: 0, tokensOut: 0 }, provider: answering, degraded: true };
            return { done: true };
          }
          return { err };
        }
      }

      for (let i = 0; i < links.length; i += 1) {
        let name = links[i];
        let forced = false;

        // REACHING CLASSIC ONLY BECAUSE EVERYONE IS COOLING IS NOT AN OUTAGE
        // (review major 5). Force the fastest cooling vendor through as the
        // probe; classic stays right behind it as the genuine fallback if the
        // probe truly fails. Without this, one slow window sticks the whole call
        // to classic and the recovered vendors are never tried again.
        if (name === 'classic' && !sticky && !hadRealFailure && clampSkips.length) {
          const fastest = clampSkips.slice().sort((a, b) => a.median - b.median)[0].name;
          log(
            `[voice-cascade] every LLM vendor is merely cooling — forcing the fastest (${fastest}) ` +
              `as a probe rather than sticking the call on classic`
          );
          clampSkips.length = 0;
          links.splice(i, 0, fastest); // classic is now at i+1
          name = fastest;
          forced = true;
        }

        const impl = link(name);
        if (!impl) continue;

        // The breaker never benches the last link: something has to answer. A
        // forced probe skips both gates on purpose — it IS the retry.
        if (!forced && name !== 'classic' && isLlmBreakerOpen(name, { ...breakerOpts, at })) {
          log(`[voice-cascade] LLM breaker OPEN for ${name} — skipping it this turn`);
          hadRealFailure = true; // a benched vendor is a real outage: classic is legit
          continue;
        }

        // THE JITTER CLAMP (V8-D2 §2). Not a failure and not a breaker: this
        // provider is answering, just too slowly. Skipped for NEW turns, said
        // ONCE, probed every Nth turn, and reported on the waterfall.
        if (!forced && name !== 'classic') {
          const cool = llmTtftClamp(name, { clampMs });
          if (cool.cooling) {
            counts.clamped += 1;
            if (cool.justCooled) {
              log(
                `[voice-cascade] LLM ${name} CLAMPED: rolling TTFT median ${Math.round(cool.median)}ms ` +
                  `> ${clampMs}ms — skipping it for new turns until it cools`
              );
            }
            clampSkips.push({ name, median: cool.median });
            yield { type: 'clamped', provider: name, medianMs: cool.median };
            continue;
          }
        }

        const res = yield* attempt(name);
        if (res.skipped) continue;
        if (res.done) return;
        // A vendor failed before speaking. This is a real failure ⇒ classic, if
        // reached from here, is a legitimate fallback.
        lastErr = res.err;
        hadRealFailure = true;
        if (!isLlmError(res.err) || isRotatable(res.err) || i < links.length - 1) {
          counts.rotations += 1;
          // THE VENDOR'S OWN WORDS, not just the status. `HTTP 400` alone is
          // undiagnosable in the field: it was already the whole log line when a
          // live rehearsal call rotated both Gemini links onto `classic` and
          // answered the rest of the booking with «ما فهمتش قصدك». The detail is
          // captured on the LlmError by http.js and was simply never printed.
          // `key=` is redacted because the Gemini key rides in the URL and a
          // vendor is free to echo the request back at us.
          log(
            `[voice-cascade] LLM ${name} failed (${res.err?.message || res.err}${describeLlmDetail(res.err)}) — rotating to ` +
              `${links[i + 1] || 'nothing left'}`
          );
          continue;
        }
        throw res.err;
      }

      // Nothing answered. This is only reachable if even `classic` threw, which
      // it is written never to do — so it is a bug, and it is reported as one
      // rather than swallowed into silence on a live call.
      throw lastErr || new Error('no LLM provider answered this turn');
    },

    /**
     * PRE-WARM (V8-D2 §2). Open the primary link's connection at ACCEPT time,
     * so the first turn of the call does not pay for TLS + HTTP/2 setup on top
     * of everything else it already pays for.
     *
     * ONLY the first usable link, and only if it implements warmUp(): the point
     * is the connection pool, and a link nobody is going to reach costs quota
     * for nothing. Never throws, never rejects, decides nothing — a warm-up
     * that fails leaves the call exactly where it was.
     *
     * @returns {Promise<string|null>} the provider that was warmed, if any
     */
    async warmUp() {
      for (const name of order) {
        if (name === 'classic') return null; // nothing to warm: no socket, no key
        const impl = link(name);
        if (!impl || typeof impl.warmUp !== 'function') continue;
        if (isLlmBreakerOpen(name, { ...breakerOpts, at: Date.now() })) continue;
        try {
          const ok = await impl.warmUp();
          if (ok) counts.prewarmed += 1;
          return ok ? name : null;
        } catch {
          // A warm-up is an optimization. It never reports, never rotates and
          // never counts against a provider — the first real turn does that.
          return null;
        }
      }
      return null;
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
