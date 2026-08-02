// Gemini TEXT streaming — the cascade's PRIMARY brain.
//
// MEASURED, not chosen by vibes (P0, 2026-08-01, 8 runs + a discarded warm-up):
//   gemini-flash-lite-latest → gemini-3.5-flash-lite : 623 ms TTFT median,
//     698 ms p95, 471 tok/s, and the ONLY candidate that never hit a free-tier
//     wall under sustained load — which under the zero-budget doctrine is not a
//     tiebreaker but a gate.
//   gemini-3-flash-preview : 906 ms median, and 5 requests/MINUTE across every
//     tenant. Usable as a rotation target, impossible as a primary.
//   gemini-flash-latest → gemini-3.6-flash : 20 requests per DAY. About four
//     phone calls. Not wired at all.
//
// THE ONE API TRAP, and it is worth the paragraph: `thinkingConfig.thinkingBudget: 0`
// — what the V7 architecture section originally specified — is REJECTED with
// HTTP 400 INVALID_ARGUMENT by both `-latest` aliases, because they now resolve
// to Gemini 3.x, which takes `thinkingLevel` instead. With `'minimal'`,
// `usageMetadata.thoughtsTokenCount` came back 0, so thinking really is off.
// Thinking left ON is a ~6 s TTFT trap: it does not error, it just makes the
// agent unusable on a phone line.
//
// CONTRACT:
//   POST https://generativelanguage.googleapis.com/v1beta/models/<model>
//        :streamGenerateContent?alt=sse&key=<key>
//   ← SSE frames: { candidates:[{ content:{ parts:[{text}|{functionCall}] } }],
//                   usageMetadata:{ promptTokenCount, candidatesTokenCount } }
//
// The key rides in the URL because that is what this endpoint accepts. The URL
// is therefore a SECRET: it is never logged, never recorded, never put on an
// event — the same rule brain/liveClient.js states for the Live socket.
import { postSse, LlmError, LLM_TIMEOUT_MS } from './http.js';
import { toGeminiTools } from './tools.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** The two models the free tier can actually carry, in P0-measured order. */
export const GEMINI_PRIMARY_MODEL = 'gemini-flash-lite-latest';
export const GEMINI_SECONDARY_MODEL = 'gemini-3-flash-preview';

/** 'minimal' | 'low'. NEVER thinkingBudget — see the header. */
export const THINKING_LEVEL = 'minimal';

/** Two short sentences. A voice turn that needs more is a turn doing it wrong. */
export const MAX_OUTPUT_TOKENS = 160;

export function buildGeminiUrl(model, apiKey) {
  return `${GEMINI_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
    String(apiKey || '')
  )}`;
}

/**
 * THE CHEAPEST REQUEST THAT WARMS THE CONNECTION (V8-D2 §2).
 *
 * What is actually bought by a pre-warm is the TLS handshake and the HTTP/2
 * connection to `generativelanguage.googleapis.com` — undici pools by ORIGIN,
 * so any request to this host leaves a warm connection behind for the first
 * real turn. Given that, the request should cost as close to nothing as
 * possible, and the candidates are not equal:
 *
 *   • `:countTokens` — free of TOKEN charges, but it is still a POST with a
 *     body against the generative endpoint and it consumes request quota on a
 *     tier whose ceiling is measured in requests per minute (P0: 5 rpm on
 *     gemini-3-flash-preview). Wrong bucket to spend from.
 *   • a 1-token `:generateContent` — spends the exact quota the call needs.
 *   • GET the model's METADATA (this) — no body, no tokens, no generation, and
 *     the same origin. It is a metadata read, and it is the whole win.
 *
 * The key still rides in the URL, so this URL is a SECRET exactly like the
 * streaming one: never logged, never recorded, never put on an event.
 */
export function buildGeminiWarmUrl(model, apiKey) {
  return `${GEMINI_BASE}/${encodeURIComponent(model)}?key=${encodeURIComponent(String(apiKey || ''))}`;
}

/** A pre-warm that has not answered in this long has failed to be a shortcut. */
export const WARM_TIMEOUT_MS = 2500;

/**
 * Neutral history → Gemini `contents`.
 * Roles: 'user' (the caller), 'assistant' (us), 'tool' (an executor result).
 * A functionResponse rides in a `user` content — that is the shape v1beta
 * accepts, and getting it wrong is a 400 in the middle of a booking.
 */
export function toGeminiContents(messages = []) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.name || 'tool', response: { result: m.result ?? {} } } }],
      });
      continue;
    }
    const parts = [];
    if (m.text) parts.push({ text: String(m.text) });
    for (const call of m.toolCalls || []) {
      parts.push({ functionCall: { name: call.name, args: call.args || {} } });
    }
    if (!parts.length) continue;
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

/**
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} [p.model]
 * @param {Array<object>} [p.tools]  brain/tools.js declarations
 * @param {number} [p.temperature]
 * @param {Function} [p.fetchImpl]
 * @param {Function} [p.logger]
 * @returns {{provider:string, model:string, stream:Function}}
 */
export function createGeminiTextLlm({
  apiKey,
  model = GEMINI_PRIMARY_MODEL,
  tools,
  temperature = 0.7,
  maxOutputTokens = MAX_OUTPUT_TOKENS,
  timeoutMs = LLM_TIMEOUT_MS,
  fetchImpl,
  logger,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const key = String(apiKey || '');
  if (!key) throw new LlmError('gemini text needs GEMINI_API_KEY', { provider: model, kind: 'config' });
  const url = buildGeminiUrl(model, key);
  const toolBlock = toGeminiTools(tools);

  const warmUrl = buildGeminiWarmUrl(model, key);

  return {
    provider: model,
    model,

    /**
     * Open the connection this link will use, before the caller needs it.
     * NEVER throws: a failed warm-up is a first turn that pays what it always
     * paid, not a call that goes wrong.
     * @returns {Promise<boolean>} true ⇒ the origin answered us
     */
    async warmUp() {
      const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
      if (typeof doFetch !== 'function') return false;
      const ac = new AbortController();
      // Unref'd: a warm-up must never be the reason a process stays alive.
      const timer = setTimeout(() => {
        try {
          ac.abort(new Error('warm-up timed out'));
        } catch {
          /* an already-aborted controller is fine */
        }
      }, WARM_TIMEOUT_MS);
      timer.unref?.();
      try {
        const res = await doFetch(warmUrl, { method: 'GET', signal: ac.signal });
        // THE BODY MUST BE READ TO THE END. An unconsumed response body keeps
        // its socket out of undici's pool (or destroys it), which would leave
        // this doing the opposite of its job. A model metadata document is
        // about a kilobyte, so reading it is free.
        try {
          await res?.text?.();
        } catch {
          /* best-effort: the connection is what we came for, not the JSON */
        }
        return true;
      } catch (err) {
        log(`[voice-cascade] ${model} pre-warm failed (${err?.message || err}) — the first turn pays for the socket`);
        return false;
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * @param {object} p
     * @param {string} p.system
     * @param {Array<object>} p.messages  neutral history (see toGeminiContents)
     * @param {AbortSignal} [p.signal]
     * @yields {{type:'text',delta}|{type:'toolCall',call}|{type:'done',usage}}
     */
    async *stream({ system = '', messages = [], signal } = {}) {
      const body = {
        contents: toGeminiContents(messages),
        generationConfig: {
          temperature,
          maxOutputTokens,
          // The trap, disarmed. See the header before touching this.
          thinkingConfig: { thinkingLevel: THINKING_LEVEL },
        },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (toolBlock) body.tools = toolBlock;

      let usage = { tokensIn: 0, tokensOut: 0 };
      let said = false;
      for await (const frame of postSse({
        fetchImpl,
        url,
        provider: model,
        signal,
        timeoutMs,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      })) {
        const u = frame?.usageMetadata;
        if (u) {
          usage = {
            tokensIn: Number(u.promptTokenCount) || usage.tokensIn,
            tokensOut: Number(u.candidatesTokenCount) || usage.tokensOut,
          };
        }
        const parts = frame?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          // A THOUGHT part is the model reasoning out loud to itself. With
          // thinkingLevel 'minimal' there should be none — but "should" is not
          // a control, and speaking one out loud would be surreal on a call.
          if (part?.thought === true) continue;
          if (typeof part?.text === 'string' && part.text) {
            said = true;
            yield { type: 'text', delta: part.text };
          }
          const fc = part?.functionCall;
          if (fc?.name) {
            yield {
              type: 'toolCall',
              call: { id: fc.id || `${fc.name}-${Date.now()}`, name: fc.name, args: fc.args || {} },
            };
          }
        }
      }
      if (!said) log(`[voice-cascade] ${model} produced no text this turn`);
      yield { type: 'done', usage };
    },
  };
}

export default createGeminiTextLlm;
