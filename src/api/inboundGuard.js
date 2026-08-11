// Inbound guard (P2-F): webhook dedupe + rate limiting, in front of the whole
// ingest pipeline.
//
// DEDUPE — Meta retries webhooks (timeouts, restarts); without a seen-set one
// redelivered message re-runs the ENTIRE pipeline: a duplicate inbox bubble,
// a second engine turn that can ADVANCE a booking flow with a stale answer,
// double media/STT spend, doubled analytics. One in-process Map<messageId, ts>
// with a TTL closes all of it (single-PM2 deployment — documented constraint;
// the PG unique index backs it up after P1-G).
//
// RATE LIMIT — one patient (or a spoofed payload in dev, where the webhook
// signature is optional) must not be able to burn unlimited LLM spend or flood
// the inbox. Token bucket per wa_id + a global per-process ceiling. The FIRST
// throttled message gets ONE localized "please slow down" so the patient is
// never ghosted; the rest of the burst is dropped silently until the window
// clears.
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MAX = 5000; // hard cap on remembered ids (memory bound)

export function createInboundGuard({
  perWaIdPerMin = 20,
  globalPerMin = 600,
  now = () => Date.now(),
} = {}) {
  const seen = new Map(); // messageId -> ts
  const buckets = new Map(); // waId -> { count, windowStart, warned }
  let globalBucket = { count: 0, windowStart: 0 };

  function pruneSeen(ts) {
    if (seen.size <= DEDUPE_MAX) {
      for (const [id, t] of seen) {
        if (ts - t < DEDUPE_TTL_MS) break; // Map is insertion-ordered
        seen.delete(id);
      }
      return;
    }
    for (const id of seen.keys()) {
      if (seen.size <= DEDUPE_MAX / 2) break;
      seen.delete(id);
    }
  }

  return {
    /** True when this messageId was already processed (and marks it seen). */
    isDuplicate(messageId) {
      if (!messageId) return false; // simulate/sandbox turns carry synthetic ids
      const ts = now();
      pruneSeen(ts);
      const prev = seen.get(messageId);
      if (prev != null && ts - prev < DEDUPE_TTL_MS) return true;
      seen.set(messageId, ts);
      return false;
    },

    /**
     * @returns {'ok' | 'throttle_notice' | 'drop'}
     *   throttle_notice → drop the turn but send ONE polite slow-down reply.
     */
    admit(waId) {
      const ts = now();
      // Global ceiling first — a flood across many ids must not melt the process.
      if (ts - globalBucket.windowStart >= 60 * 1000) globalBucket = { count: 0, windowStart: ts };
      globalBucket.count += 1;
      if (globalBucket.count > globalPerMin) return 'drop';

      if (!waId) return 'ok';
      let b = buckets.get(waId);
      if (!b || ts - b.windowStart >= 60 * 1000) {
        b = { count: 0, windowStart: ts, warned: false };
        buckets.set(waId, b);
        // Opportunistic prune: expired buckets go on each new window.
        if (buckets.size > 2000) {
          for (const [k, v] of buckets) {
            if (ts - v.windowStart >= 60 * 1000) buckets.delete(k);
          }
        }
      }
      b.count += 1;
      if (b.count <= perWaIdPerMin) return 'ok';
      if (!b.warned) {
        b.warned = true;
        return 'throttle_notice';
      }
      return 'drop';
    },
  };
}

// Localized "please slow down" — warm, once per burst window.
export const THROTTLE_REPLY = {
  ar: 'رسائل برشا في وقت قصير 🙏 أعطيني ثانية باش نجاوبك على كل شيء بالترتيب.',
  fr: 'Beaucoup de messages d’un coup 🙏 Une seconde, je vous réponds à tout dans l’ordre.',
  en: 'Quite a few messages at once 🙏 Give me a second and I’ll answer everything in order.',
};

export default createInboundGuard;
