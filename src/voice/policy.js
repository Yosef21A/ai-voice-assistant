// Voice policy (V1) — pure decisions about audio, zero I/O.
//
// Two jobs:
//   1. turn the roadmap's "voice ≤ 2 min" into something ENFORCEABLE;
//   2. grade a transcript honestly, without inventing a confidence number.
//
// ── Why the cap is in BYTES, not seconds ────────────────────────────────────
// The WhatsApp Cloud API `audio` object carries { id, mime_type, sha256,
// caption, filename } and NO duration (verified against normalizeWhatsApp in
// src/server.js). A duration check would be theatre. Graph's media METADATA
// does carry file_size, and src/whatsapp/media.js already refuses oversize
// before downloading — so a per-mime byte cap is a real gate that costs zero
// CDN bytes and zero STT calls when it trips.
//
// ── Why the grade is not a confidence score ─────────────────────────────────
// Gemini's self-reported `confidence` is uncalibrated; treating it as a
// probability would be a lie with a decimal point on it. The grade is a
// three-state BEHAVIOUR decision — act / read the whole thing back / admit we
// did not understand — driven mostly by structural signals that are actually
// observable. The grade never decides whether to TRUST a slot: the humility
// gate in engine/voiceSlots.js confirms voice-derived slots unconditionally.

/**
 * Rough encoder bitrates → bytes per second. WhatsApp voice notes are opus mono
 * at roughly 16-24 kbps; the others are what a forwarded file might arrive as.
 * Deliberately generous: this bounds cost and latency, it is not a precise clock.
 */
export const BYTES_PER_SECOND = Object.freeze({
  'audio/ogg': 3000,
  'audio/mpeg': 16000,
  'audio/mp4': 16000,
  'audio/aac': 16000,
  'audio/amr': 1600,
});

const bare = (m) => String(m || '').split(';')[0].trim().toLowerCase();

/** Byte cap standing in for `maxSeconds` of audio at this mime's typical rate. */
export function estimateMaxBytes(mimeType, maxSeconds = 120) {
  const rate = BYTES_PER_SECOND[bare(mimeType)] || 16000;
  return Math.max(1, Math.round(rate * Number(maxSeconds || 120)));
}

/** Approximate duration, for logs and the sparse-speech signal only. */
export function estimateDurationSec(bytes, mimeType) {
  const rate = BYTES_PER_SECOND[bare(mimeType)] || 16000;
  const n = Number(bytes) || 0;
  return n > 0 ? n / rate : 0;
}

// Spans the model itself flags as unintelligible, in the registers we serve.
const UNCLEAR_MARKERS = [/\[\?\]/, /\[inaudible\]/i, /\[unclear\]/i, /غير واضح/, /مش واضح/];

// A model that answered instead of transcribing, or refused.
const REFUSAL_MARKERS = [
  /^\s*(i'?m sorry|sorry,|i cannot|i can'?t|unable to)/i,
  /^\s*(je suis désolé|désolé,|je ne peux pas)/i,
  /^\s*(عذرا|آسف|ما نجمش)/,
];

/** A transcript that is one token repeated — a classic decoder loop. */
function isRepetitionLoop(text) {
  const toks = String(text).trim().split(/\s+/).filter(Boolean);
  if (toks.length < 6) return false;
  const uniq = new Set(toks.map((w) => w.toLowerCase()));
  return uniq.size <= Math.max(1, Math.floor(toks.length / 6));
}

/**
 * Grade a transcription result.
 *
 * @returns {{grade:'ok'|'weak'|'failed', signals:string[]}}
 *   failed → we did not understand; send the warm fallback, act on nothing.
 *   weak   → we heard something but do not trust the wording; read the WHOLE
 *            transcript back before acting on it.
 *   ok     → feed it into the pipeline as if typed (slots still get the
 *            confirm-before-lock treatment).
 */
export function gradeTranscript({
  transcript = '',
  selfReport = {},
  bytes = 0,
  mimeType = '',
  minConfidence = 0.5,
  maxChars = 1500,
} = {}) {
  const signals = [];
  const text = String(transcript || '').trim();

  if (!text) return { grade: 'failed', signals: ['empty'] };
  if (selfReport.is_speech === false) return { grade: 'failed', signals: ['not_speech'] };
  // Punctuation / markers only — nothing was actually said.
  if (!/[\p{L}\p{N}]/u.test(text)) return { grade: 'failed', signals: ['no_words'] };
  if (REFUSAL_MARKERS.some((re) => re.test(text))) {
    return { grade: 'failed', signals: ['model_refusal'] };
  }
  if (isRepetitionLoop(text)) return { grade: 'failed', signals: ['repetition_loop'] };

  const markerHits = UNCLEAR_MARKERS.filter((re) => re.test(text)).length;
  if (markerHits) signals.push('unclear_markers');
  if (selfReport.unclear === true) signals.push('self_unclear');

  const conf = Number(selfReport.confidence);
  if (Number.isFinite(conf) && conf < minConfidence) signals.push('low_confidence');

  // Sparse speech: a long recording that produced almost no words usually means
  // the model gave up on most of it. Only applied above 4s — a genuine one-word
  // "ايه" is a perfectly good short answer and must not be punished.
  const durationSec = estimateDurationSec(bytes, mimeType);
  if (durationSec > 4 && text.length / durationSec < 1.2) signals.push('sparse_speech');

  if (text.length > maxChars) signals.push('over_length');

  return { grade: signals.length ? 'weak' : 'ok', signals };
}
