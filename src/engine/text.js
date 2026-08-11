// Shared text utilities for the engine and every ingest path.
//
// Digit normalization maps Arabic-Indic (٠-٩, U+0660–U+0669) and Eastern
// Arabic-Indic / Persian (۰-۹, U+06F0–U+06F9) digits to ASCII 0-9 so that ALL
// downstream parsing (datetime, contact, intent, specialty, detectors) sees one
// digit alphabet. It runs at ingest (webhook/simulate/sandbox) AND defensively
// inside the engine; the function is idempotent so double application is safe.

const DIGIT_MAP = {
  // Arabic-Indic
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  // Eastern Arabic-Indic (Persian/Urdu keyboards are common on Libyan phones)
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

const DIGIT_RE = /[٠-٩۰-۹]/g;

/** Map Arabic-Indic and Eastern Arabic-Indic digits to ASCII. Idempotent. */
export function normalizeDigits(s) {
  return String(s ?? '').replace(DIGIT_RE, (d) => DIGIT_MAP[d] || d);
}

/**
 * Split a reply into WhatsApp-sized bubbles: at most `max` bubbles, split on
 * sentence boundaries (never mid-sentence), preferring the earliest natural
 * break past the midpoint. Texts with ≤2 sentences (or explicit line-block
 * structure like recaps) come back as a single bubble.
 */
export function splitBubbles(text, max = 2) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  // Structured messages (lists/recaps with bullet lines) must stay whole.
  if (/\n\s*[•\-\d]/.test(s)) return [s];
  const parts = s.split(/(?<=[.!?؟…]|\n)\s+/).filter(Boolean);
  if (parts.length <= 2 || max < 2) return [s];
  const mid = Math.ceil(parts.length / 2);
  const first = parts.slice(0, mid).join(' ').trim();
  const second = parts.slice(mid).join(' ').trim();
  return second ? [first, second] : [s];
}
