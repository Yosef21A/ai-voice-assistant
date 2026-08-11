// Knowledge-base FAQ matching against the tenant's `faq` entries.
import { normalize } from './slots.js';

/**
 * Find the best-matching FAQ entry for a query (most keyword hits wins).
 * @returns the entry or null
 */
export function matchFaq(text, clinic) {
  const t = normalize(text);
  if (!t) return null;
  let best = null;
  let bestScore = 0;
  for (const entry of clinic.faq || []) {
    let score = 0;
    for (const kw of entry.keywords || []) {
      if (t.includes(normalize(kw))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore > 0 ? best : null;
}

/** Return the localized answer text for an entry (falls back FR -> EN -> AR). */
export function faqAnswer(entry, lang) {
  const a = entry.answer || {};
  return a[lang] || a.fr || a.en || a.ar || '';
}
