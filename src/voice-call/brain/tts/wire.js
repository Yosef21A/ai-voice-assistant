// The shared wire discipline for every TTS provider: ONE fetch, ONE abort
// budget, ONE PCM reader. Both providers (azure, elevenlabs) speak the same
// dialect of HTTP — POST some text, get back a chunked stream of raw PCM16LE
// mono at 24 kHz — so the tricky parts live here exactly once.
//
// Three things in this file are load-bearing, and all three were chosen because
// of what a phone call does when they are wrong:
//
//  1. THE ODD-BYTE CARRY. A network chunk boundary does not respect sample
//     boundaries: a 4097-byte chunk carries 2048 samples and HALF of the next
//     one. Dropping that half-sample (the obvious `Math.floor(len/2)` bug)
//     shifts every subsequent byte pair by one and turns the rest of the
//     sentence into white noise — and it only happens on chunk boundaries, so
//     it reproduces roughly never in a unit test written after the fact. The
//     leftover byte is carried into the next chunk. Always.
//  2. THE STALL TIMER, NOT A DEADLINE — PLUS A DEADLINE. The 8 s budget is
//     re-armed around every single read rather than set once for the whole
//     request: a one-shot 8 s deadline would abort a legitimately long sentence
//     mid-word, while a stall timer aborts a provider that stopped sending,
//     which is the failure we actually have. Nothing is armed while the consumer
//     is holding a chunk. On TOP of that sits an overall per-synthesis budget
//     (30 s), because a provider that dribbles one byte every 7.9 s would defeat
//     a stall timer forever — and one sentence is bounded by MAX_SENTENCE_CHARS,
//     so 30 s is already an order of magnitude more than any of ours needs.
//  3. A CALLER ABORT IS NOT A PROVIDER FAILURE. When the loop cancels us
//     (barge-in, hang-up, emergency override) the original abort error is
//     re-thrown untouched. Only a genuine provider problem becomes a TtsError,
//     because a TtsError is what ends the call (see loop.js, 'tts_lost') and a
//     caller who interrupted the agent must never hang up the phone for them.
//
// Nothing here reads config, a clock or a global: `fetchImpl` is injected all
// the way down, which is how the whole tier is tested without a socket.

/** Time a provider has to answer, and to keep answering between chunks. */
export const TTS_TIMEOUT_MS = 8000;

/**
 * Hard ceiling on ONE synthesis, stall timer or not. A sentence is capped at
 * MAX_SENTENCE_CHARS (brain/loop.js) — roughly 20 s of speech at the outside —
 * so anything past this is a provider misbehaving, not a long sentence.
 */
export const TTS_MAX_SYNTH_MS = 30000;

/** Longest provider error body we quote back into a log line. */
const MAX_DETAIL_CHARS = 200;

/**
 * The ONE error type the loop degrades on. Anything else escaping a provider is
 * a bug in our code, and is logged as such rather than silently swallowed.
 */
export class TtsError extends Error {
  /**
   * @param {string} message
   * @param {object} [p]
   * @param {string} [p.provider]  'azure' | 'elevenlabs'
   * @param {number} [p.status]    HTTP status when there was one
   * @param {string} [p.kind]      'http' | 'quota' | 'network' | 'timeout' | 'empty' | 'config'
   * @param {string} [p.detail]    a truncated slice of the provider's own body
   * @param {Error}  [p.cause]
   */
  constructor(message, { provider = null, status = null, kind = 'http', detail = '', cause } = {}) {
    super(message);
    this.name = 'TtsError';
    /** Duck-typed so a cross-module `instanceof` can never be the thing that fails. */
    this.isTtsError = true;
    this.provider = provider;
    this.status = status;
    this.kind = kind;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
}

/** True for anything a provider is allowed to throw at the loop. */
export function isTtsError(err) {
  return !!(err && (err.isTtsError === true || err instanceof TtsError));
}

/** Bytes → Int16Array, little-endian, signed. Length MUST be even. */
function toInt16LE(bytes, count) {
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    const lo = bytes[i * 2];
    const hi = bytes[i * 2 + 1];
    // (hi << 8 | lo) is unsigned; the <<16>>16 pair sign-extends it.
    out[i] = (((hi << 8) | lo) << 16) >> 16;
  }
  return out;
}

/**
 * Every await in this file goes through here.
 *
 * The AbortController tears down the real socket, and `fetch` honours it — but
 * "the transport honours our signal" is an assumption, and an assumption that
 * fails silently here does not throw, it HANGS: the utterance never settles,
 * the speech queue behind it never advances, and the caller listens to nothing
 * until the call cap fires. So the budget is enforced on OUR side as well,
 * where nothing outside this process gets a vote.
 */
function withDeadline(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    // NOT unref'd, deliberately. This timer is the only thing guaranteeing the
    // returned promise settles at all; unref'ing it means that when nothing
    // else is pending the loop drains and the await hangs forever instead of
    // rejecting. It is always cleared the moment the operation settles.
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

/**
 * Read a failing provider's error body — best effort, on a budget. A 500 whose
 * body never arrives must not become the thing that holds the call: we would
 * rather throw the HTTP error with no detail than not throw at all.
 */
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
 * POST some text at a TTS endpoint and stream the answer back as 24 kHz PCM.
 *
 * @param {object} p
 * @param {Function} [p.fetchImpl]      injected everywhere; defaults to globalThis.fetch
 * @param {string} p.url
 * @param {object} p.init               fetch init MINUS the signal (we own that)
 * @param {AbortSignal} [p.signal]      the CALLER's cancellation (barge-in)
 * @param {string} p.provider
 * @param {number} [p.timeoutMs]  per-chunk stall budget
 * @param {number} [p.overallMs]  hard ceiling on the whole synthesis
 * @yields {Int16Array} PCM16 mono @24 kHz
 */
export async function* streamTtsPcm({
  fetchImpl,
  url,
  init = {},
  signal,
  provider = 'tts',
  timeoutMs = TTS_TIMEOUT_MS,
  overallMs = TTS_MAX_SYNTH_MS,
} = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new TtsError('no fetch implementation is available in this runtime', {
      provider,
      kind: 'config',
    });
  }

  const ac = new AbortController();
  let stalled = false;
  let timer = null;
  const giveUp = (why) => {
    stalled = true;
    try {
      ac.abort(new Error(`${provider} TTS ${why}`));
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
  // The one timer that is NEVER re-armed: a provider dribbling a byte every
  // 7.9 s satisfies the stall timer forever, and would hold a call open behind
  // one sentence until the call cap fired.
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
  /** The overall ceiling, enforced in the loop as well as by the timer above. */
  const overdue = () => Date.now() - startedAt >= overallMs;
  const budgetError = (why) =>
    new TtsError(`${provider} TTS ${why}`, { provider, kind: 'timeout' });

  /** A failed fetch is only OUR problem when the caller did not cancel it. */
  const wrap = (err) => {
    if (signal?.aborted) return err; // barge-in / hang-up: hand it back untouched
    if (isTtsError(err)) return err; // already precise; do not re-label it
    return new TtsError(
      stalled
        ? `${provider} TTS timed out after ${timeoutMs}ms`
        : `${provider} TTS request failed: ${err?.message || err}`,
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
      // Reading the error body is another network read, and a provider that is
      // failing is exactly the one that might never finish sending it. Armed,
      // or a 500 could hang the utterance for as long as the socket stays open.
      let detail;
      arm();
      try {
        detail = await safeText(res, timeoutMs);
      } finally {
        disarm();
      }
      throw new TtsError(`${provider} TTS returned HTTP ${Number.isFinite(status) ? status : 'n/a'}`, {
        provider,
        status: Number.isFinite(status) ? status : null,
        // 429 is the one worth naming: it is the quota wall, and on a paid voice
        // tier it is the failure a founder will actually meet.
        kind: status === 429 ? 'quota' : 'http',
        detail,
      });
    }

    const body = res?.body;
    let yielded = 0;

    if (!body || typeof body.getReader !== 'function') {
      // No streaming body (an older polyfill, or a provider that buffered).
      // Take the whole thing rather than fail: audio late beats no audio.
      let buf = null;
      arm(); // buffering the whole body is still a network read
      try {
        if (typeof res?.arrayBuffer === 'function') {
          buf = await withDeadline(res.arrayBuffer(), timeoutMs, () =>
            budgetError(`timed out after ${timeoutMs}ms`)
          );
        }
      } catch (err) {
        throw wrap(err);
      } finally {
        disarm();
      }
      const bytes = buf ? new Uint8Array(buf) : new Uint8Array(0);
      const samples = bytes.length >> 1;
      if (samples > 0) {
        yielded += samples;
        yield toInt16LE(bytes, samples);
      }
    } else {
      const reader = body.getReader();
      /** The half-sample byte left over from the previous chunk (-1 = none). */
      let carry = -1;
      try {
        for (;;) {
          // Checked HERE, not only on the timer: a provider that dribbles one
          // byte just inside the stall budget satisfies that timer forever, and
          // one sentence is bounded, so a ceiling is always the right answer.
          if (overdue()) throw budgetError(`exceeded ${overallMs}ms`);
          let chunk;
          arm();
          try {
            chunk = await withDeadline(reader.read(), timeoutMs, () =>
              budgetError(`stalled for ${timeoutMs}ms`)
            );
          } catch (err) {
            throw wrap(err);
          } finally {
            disarm();
          }
          if (!chunk || chunk.done) break;
          let bytes = chunk.value;
          if (!bytes || !bytes.length) continue;
          if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
          if (carry >= 0) {
            const merged = new Uint8Array(bytes.length + 1);
            merged[0] = carry;
            merged.set(bytes, 1);
            bytes = merged;
            carry = -1;
          }
          if (bytes.length & 1) carry = bytes[bytes.length - 1];
          const samples = bytes.length >> 1;
          if (!samples) continue;
          yielded += samples;
          yield toInt16LE(bytes, samples);
        }
      } finally {
        // Abandoning the generator (the loop broke out on a barge-in) must not
        // leave a socket half-read.
        try {
          reader.cancel?.();
        } catch {
          /* best-effort */
        }
      }
    }

    // A 200 with no audio is a provider failure wearing a success code. Saying
    // nothing at all is the one outcome this tier exists to prevent, so it is
    // reported rather than tolerated.
    if (!yielded) {
      throw new TtsError(`${provider} TTS returned an empty audio stream`, { provider, kind: 'empty' });
    }
  } finally {
    disarm();
    clearTimeout(overallTimer);
    signal?.removeEventListener?.('abort', onCallerAbort);
  }
}

export default streamTtsPcm;
