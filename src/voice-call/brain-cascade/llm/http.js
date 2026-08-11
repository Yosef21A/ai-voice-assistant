// The shared wire discipline for every streaming LLM: ONE fetch, ONE stall
// budget, ONE SSE reader. Gemini and the OpenAI-compatible endpoints (Cerebras,
// Groq) all answer with `text/event-stream` frames of JSON, so the tricky parts
// live here exactly once — deliberately the same shape as brain/tts/wire.js, so
// this codebase has ONE mental model for "a vendor stopped answering".
//
// FOUR THINGS THAT ARE LOAD-BEARING:
//
//  1. A STALL TIMER, NOT A DEADLINE — PLUS A DEADLINE. The per-chunk budget is
//     re-armed around every read: a one-shot deadline would abort a long but
//     healthy answer, while a stall timer aborts a vendor that stopped sending,
//     which is the failure we actually have. On top sits an overall ceiling,
//     because a vendor dribbling one byte just inside the stall budget would
//     satisfy that timer forever and hold a phone call open behind it.
//  2. A CALLER ABORT IS NOT A VENDOR FAILURE. When the orchestrator cancels us
//     (barge-in, hang-up, a speculative turn overtaken by the real one) the
//     original abort error is re-thrown untouched. Only a genuine vendor
//     problem becomes an LlmError — and an LlmError is what rotates the chain,
//     so mislabelling a barge-in would bench a healthy provider.
//  3. SSE FRAMES SPAN CHUNK BOUNDARIES. A `data:` line arrives split across two
//     network reads more often than anyone expects. The buffer is carried; a
//     partial line is never parsed.
//  4. 429 IS THE FAILURE THIS PRODUCT ACTUALLY MEETS. Free-tier quota is the
//     whole reason the rotation chain exists (a 5-requests-per-minute model is
//     a hard ceiling across every tenant), so it gets its own `kind` and its
//     own breaker treatment upstream.
//
// Nothing here reads config, a clock or a global: `fetchImpl` is injected all
// the way down, which is how the whole tier is tested without a socket.

/** Time a provider has to answer, and to keep answering between chunks. */
export const LLM_TIMEOUT_MS = 8000;
/** Hard ceiling on ONE turn. A voice reply is two short sentences. */
export const LLM_MAX_TURN_MS = 20000;
/** Longest provider error body quoted back into a log line. */
const MAX_DETAIL_CHARS = 200;

/**
 * The ONE error type the chain rotates on. Anything else escaping a provider is
 * a bug in our code and is logged as such rather than silently swallowed.
 */
export class LlmError extends Error {
  /**
   * @param {string} message
   * @param {object} [p]
   * @param {string} [p.provider]
   * @param {number} [p.status]
   * @param {string} [p.kind] 'http'|'quota'|'network'|'timeout'|'empty'|'config'
   * @param {string} [p.detail]
   * @param {Error} [p.cause]
   */
  constructor(message, { provider = null, status = null, kind = 'http', detail = '', cause } = {}) {
    super(message);
    this.name = 'LlmError';
    /** Duck-typed so a cross-module `instanceof` can never be the thing that fails. */
    this.isLlmError = true;
    this.provider = provider;
    this.status = status;
    this.kind = kind;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
}

export function isLlmError(err) {
  return !!(err && (err.isLlmError === true || err instanceof LlmError));
}

/**
 * Observe a promise we are not going to await. `reader.cancel()` is called for
 * its side effect, but on an errored (aborted) stream it returns a promise
 * already rejected with the abort reason — and a rejection nobody looks at ends
 * the process. Not interested is not the same as not looking. (V7-P2.1.)
 */
function settle(maybePromise) {
  if (maybePromise && typeof maybePromise.then === 'function') {
    maybePromise.then(
      () => {},
      () => {}
    );
  }
}

/** True for the failures that mean "try somebody else RIGHT NOW". */
export function isRotatable(err) {
  if (!isLlmError(err)) return false;
  if (err.kind === 'quota' || err.kind === 'timeout' || err.kind === 'network' || err.kind === 'empty') return true;
  const s = Number(err.status);
  return Number.isFinite(s) && (s === 429 || s >= 500);
}

function withDeadline(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    // NOT unref'd, deliberately: this timer is the only thing guaranteeing the
    // returned promise settles at all. It is cleared the moment it does.
    const timer = setTimeout(() => reject(onTimeout()), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function safeText(res, ms) {
  try {
    if (typeof res?.text !== 'function') return '';
    const body = await withDeadline(res.text(), ms, () => new Error('detail read timed out'));
    return String(body || '').slice(0, MAX_DETAIL_CHARS);
  } catch {
    return '';
  }
}

/**
 * POST a request and yield each parsed SSE `data:` payload.
 *
 * @param {object} p
 * @param {Function} [p.fetchImpl]
 * @param {string} p.url
 * @param {object} p.init          fetch init MINUS the signal (we own that)
 * @param {AbortSignal} [p.signal] the CALLER's cancellation
 * @param {string} p.provider
 * @param {number} [p.timeoutMs]   per-chunk stall budget
 * @param {number} [p.overallMs]   hard ceiling on the whole turn
 * @yields {object} one parsed JSON payload per `data:` line ('[DONE]' ends it)
 */
export async function* postSse({
  fetchImpl,
  url,
  init = {},
  signal,
  provider = 'llm',
  timeoutMs = LLM_TIMEOUT_MS,
  overallMs = LLM_MAX_TURN_MS,
} = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new LlmError('no fetch implementation is available in this runtime', { provider, kind: 'config' });
  }

  const ac = new AbortController();
  let stalled = false;
  let timer = null;
  const giveUp = (why) => {
    stalled = true;
    try {
      ac.abort(new Error(`${provider} ${why}`));
    } catch {
      /* an already-aborted controller is fine */
    }
  };
  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => giveUp('stalled'), timeoutMs);
    timer.unref?.();
  };
  const overallTimer = setTimeout(() => giveUp(`exceeded ${overallMs}ms`), overallMs);
  overallTimer.unref?.();
  const onCallerAbort = () => {
    try {
      ac.abort(signal?.reason);
    } catch {
      /* same */
    }
  };
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener?.('abort', onCallerAbort, { once: true });
  }

  const startedAt = Date.now();
  const overdue = () => Date.now() - startedAt >= overallMs;
  const budgetError = (why) => new LlmError(`${provider} ${why}`, { provider, kind: 'timeout' });
  const wrap = (err) => {
    if (signal?.aborted) return err; // barge-in / restart: hand it back untouched
    if (isLlmError(err)) return err;
    return new LlmError(
      stalled ? `${provider} timed out after ${timeoutMs}ms` : `${provider} request failed: ${err?.message || err}`,
      { provider, kind: stalled ? 'timeout' : 'network', cause: err }
    );
  };

  try {
    let res;
    arm();
    try {
      res = await withDeadline(doFetch(url, { ...init, signal: ac.signal }), timeoutMs, () =>
        budgetError(`timed out after ${timeoutMs}ms`)
      );
    } catch (err) {
      throw wrap(err);
    } finally {
      disarm();
    }

    const status = Number(res?.status);
    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      let detail;
      arm();
      try {
        detail = await safeText(res, timeoutMs);
      } finally {
        disarm();
      }
      throw new LlmError(`${provider} returned HTTP ${Number.isFinite(status) ? status : 'n/a'}`, {
        provider,
        status: Number.isFinite(status) ? status : null,
        // 429 is the wall this doctrine is built around: free-tier quota. It
        // must rotate the chain, never silently degrade to classic.
        kind: status === 429 ? 'quota' : 'http',
        detail,
      });
    }

    const body = res?.body;
    let frames = 0;
    let buffer = '';

    /** Parse whatever complete lines the buffer now holds. */
    function* drain(flush) {
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const payload = parseLine(line);
        if (payload !== undefined) yield payload;
      }
      if (flush && buffer.trim()) {
        const payload = parseLine(buffer.trim());
        buffer = '';
        if (payload !== undefined) yield payload;
      }
    }

    function parseLine(line) {
      if (!line || !line.startsWith('data:')) return undefined;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return undefined;
      try {
        return JSON.parse(data);
      } catch {
        // A vendor that emits a half-JSON frame is a vendor bug, not a reason
        // to end a call: skip the frame and keep reading.
        return undefined;
      }
    }

    if (!body || typeof body.getReader !== 'function') {
      // No streaming body (a polyfill, or a vendor that buffered). Take the lot
      // rather than fail: a late answer beats no answer.
      let text = '';
      arm();
      try {
        if (typeof res?.text === 'function') {
          text = await withDeadline(res.text(), timeoutMs, () => budgetError(`timed out after ${timeoutMs}ms`));
        }
      } catch (err) {
        throw wrap(err);
      } finally {
        disarm();
      }
      buffer = String(text || '');
      for (const payload of drain(true)) {
        frames += 1;
        yield payload;
      }
    } else {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          if (overdue()) throw budgetError(`exceeded ${overallMs}ms`);
          let chunk;
          arm();
          try {
            chunk = await withDeadline(reader.read(), timeoutMs, () => budgetError(`stalled for ${timeoutMs}ms`));
          } catch (err) {
            throw wrap(err);
          } finally {
            disarm();
          }
          if (!chunk || chunk.done) break;
          const value = chunk.value;
          if (!value || !value.length) continue;
          buffer +=
            typeof value === 'string'
              ? value
              : decoder.decode(value instanceof Uint8Array ? value : new Uint8Array(value), { stream: true });
          for (const payload of drain(false)) {
            frames += 1;
            yield payload;
          }
        }
        for (const payload of drain(true)) {
          frames += 1;
          yield payload;
        }
      } finally {
        // Abandoning the generator (a barge-in broke the consumer's loop) must
        // not leave a socket half-read — and must not leave the promise
        // cancel() returns unobserved. On an ABORTED body that promise is
        // already rejected with the abort reason, and an unhandled rejection is
        // a fatal exception in this runtime: the same shape that killed the
        // process on the founder's live call (see brain/tts/wire.js §4).
        try {
          settle(reader.cancel?.());
        } catch {
          /* best-effort */
        }
      }
    }

    // A 200 with no frames is a vendor failure wearing a success code, and on a
    // phone call it is indistinguishable from the agent going mute. Rotate.
    if (!frames) {
      throw new LlmError(`${provider} returned an empty stream`, { provider, kind: 'empty' });
    }
  } finally {
    disarm();
    clearTimeout(overallTimer);
    signal?.removeEventListener?.('abort', onCallerAbort);
  }
}

export default postSse;
