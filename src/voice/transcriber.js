// Voice transcription orchestrator (V1) — the only thing that turns audio bytes
// into a transcript, and the only thing that decides how a failure degrades.
//
// It NEVER throws. Every path returns a verdict the ingest layer can act on,
// because the one behaviour this feature must never have is silence: a patient
// who sent a voice note always gets an answer, even if that answer is "I heard
// you but couldn't make it out — can you resend or type it?".
//
// ── Quota discipline ────────────────────────────────────────────────────────
// The free Gemini tier has a daily quota this project has already exhausted
// once, and the failure mode was ugly: the model silently degraded and the bot
// ran classic without anyone noticing. Voice is the greedy path (audio tokens
// dwarf text), so it gets a circuit breaker that VOICE YIELDS TO TEXT: a 429
// opens the breaker immediately and suppresses transcription for a cooldown,
// while the typed-conversation path — the thing the clinic actually sells — is
// never gated. Degrading voice to "a human will listen" is survivable;
// degrading the conversation is not.
import { gradeTranscript, estimateDurationSec } from './policy.js';
import { buildTranscriptionRequest } from '../llm/stt.js';

/**
 * Shared breaker + counters. In-memory and per-process, which matches the
 * documented single-PM2-instance constraint of the JSON store; it becomes
 * per-worker (and therefore N× more permissive) if that ever changes — noted in
 * the RUNBOOK rather than silently assumed away.
 */
export function createQuota({ threshold = 3, cooldownMs = 60000, now = () => Date.now() } = {}) {
  let failures = 0;
  let openedAt = 0;
  return {
    /** Record a failure. A 429/RESOURCE_EXHAUSTED opens the breaker at once —
     *  the window is spent, and retrying only burns more of it. */
    note(errOrStatus) {
      const s = typeof errOrStatus === 'number' ? String(errOrStatus) : String(errOrStatus?.message || errOrStatus || '');
      if (/429|RESOURCE_EXHAUSTED|quota/i.test(s)) {
        openedAt = now();
        failures = threshold;
        return;
      }
      failures += 1;
      if (failures >= threshold) openedAt = now();
    },
    noteOk() {
      failures = 0;
      openedAt = 0;
    },
    isThrottled() {
      if (!openedAt) return false;
      if (now() - openedAt >= cooldownMs) {
        // Half-open: allow one probe through.
        openedAt = 0;
        failures = Math.max(0, threshold - 1);
        return false;
      }
      return true;
    },
  };
}

/**
 * @param {object} deps
 * @param {object} deps.provider  must expose transcribeAudio(); absence of that
 *                                method is what keeps classic mode unchanged.
 * @param {object} [deps.config]
 * @param {object} [deps.quota]
 * @param {Function} [deps.logger]
 * @param {Function} [deps.now]
 */
export function createTranscriber({ provider, config = {}, quota, logger, now = () => Date.now() } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const breaker = quota || createQuota({
    threshold: config.voiceBreakerThreshold ?? 3,
    cooldownMs: config.voiceBreakerCooldownMs ?? 60000,
    now,
  });
  const timeoutMs = Number(config.voiceSttTimeoutMs) || 15000;
  const deadlineMs = Number(config.voiceSttDeadlineMs) || 22000;
  const minConfidence = Number(config.voiceMinConfidence ?? 0.5);
  const maxChars = Number(config.voiceMaxTranscriptChars) || 1500;

  return {
    /**
     * @returns {Promise<{ok:boolean, transcript:string, lang:string|null,
     *   grade:'ok'|'weak'|'failed', signals:string[], durationSec:number,
     *   ms:number, reason:string|null}>}
     */
    async transcribe({ bytes, mimeType } = {}) {
      const started = now();
      const fail = (reason, signals = []) => ({
        ok: false,
        transcript: '',
        lang: null,
        grade: 'failed',
        signals,
        durationSec: estimateDurationSec(bytes?.length || 0, mimeType),
        ms: now() - started,
        reason,
      });

      if (!provider || typeof provider.transcribeAudio !== 'function') return fail('no_stt_provider');
      if (!bytes || !bytes.length) return fail('no_bytes');
      if (breaker.isThrottled()) return fail('circuit_open', ['throttled']);

      const deadline = started + deadlineMs;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (now() >= deadline) break;
        try {
          const res = await provider.transcribeAudio({
            ...buildTranscriptionRequest({ bytes, mimeType }),
            timeoutMs: Math.min(timeoutMs, Math.max(1, deadline - now())),
          });
          breaker.noteOk();
          const graded = gradeTranscript({
            transcript: res?.transcript,
            selfReport: res || {},
            bytes: bytes.length,
            mimeType,
            minConfidence,
            maxChars,
          });
          const transcript = String(res?.transcript || '').trim().slice(0, maxChars);
          log('[voice] transcribed', {
            grade: graded.grade,
            signals: graded.signals,
            chars: transcript.length,
            ms: now() - started,
          });
          return {
            ok: graded.grade !== 'failed',
            transcript: graded.grade === 'failed' ? '' : transcript,
            lang: res?.language || null,
            grade: graded.grade,
            signals: graded.signals,
            durationSec: estimateDurationSec(bytes.length, mimeType),
            ms: now() - started,
            reason: graded.grade === 'failed' ? graded.signals[0] || 'ungradeable' : null,
          };
        } catch (err) {
          lastErr = err;
          breaker.note(err);
          // A 429 is terminal for this turn: the window is spent and a retry
          // only digs deeper. Anything else gets exactly one more try.
          if (/429|RESOURCE_EXHAUSTED|quota/i.test(String(err?.message || err))) break;
        }
      }
      log('[voice] transcription failed', { error: String(lastErr?.message || lastErr) });
      return fail('provider_error', [String(lastErr?.message || 'error').slice(0, 60)]);
    },
  };
}

export default createTranscriber;
