// KB → live engine bridge (P2-B). The engine answers FAQs from the in-memory
// legacy clinic object's `clinic.faq` only — dashboard-created kb_entries were
// never consulted (P1-D known gap). This module closes it: active kb_entries
// are mapped into clinic.faq-shaped rows and merged onto the LIVE clinic
// object, so wizard KB + trained answers reach patients immediately and after
// every restart.
//
// Merge semantics: `clinic._baseFaq` snapshots the registry-seeded faq on
// first merge; every re-merge rebuilds `clinic.faq = [kb entries first, then
// base]` — KB wins matchFaq ties (owner-trained answers beat stale seed data)
// and repeated merges never duplicate.
import { normalizeQuestion } from '../stats/index.js';

/** Derive matchFaq keywords from a question when the entry carries none. */
export function deriveKeywords(question) {
  return normalizeQuestion(question)
    .split(' ')
    .filter((w) => w.length >= 3)
    .slice(0, 8);
}

/** Active, answerable kb_entries → clinic.faq-shaped rows. Price rows are NOT
 *  FAQ answers (their `answer` is {from,currency,notes}) and are skipped. */
export function kbToFaqEntries(entries = []) {
  return entries
    .filter(
      (e) =>
        e &&
        e.status === 'active' &&
        e.source !== 'price' &&
        e.answer &&
        (e.answer.ar || e.answer.fr || e.answer.en)
    )
    .map((e) => ({
      id: `kb:${e.key}`,
      keywords: Array.isArray(e.keywords) && e.keywords.length ? e.keywords : deriveKeywords(e.question),
      answer: { ar: e.answer.ar || '', fr: e.answer.fr || '', en: e.answer.en || '' },
    }))
    .filter((e) => e.keywords.length > 0); // matchFaq can never hit a keywordless entry
}

/** Re-merge one tenant's KB into its live clinic object. Safe no-op when the
 *  store lacks the legacy surface (e.g. bare Postgres in scripts). */
export async function mergeTenantKb(store, tenantId) {
  if (typeof store.getClinicById !== 'function') return false;
  const live = store.getClinicById(tenantId);
  if (!live) return false;
  const entries = await store.kbEntries.list(tenantId, { status: 'active' });
  if (!live._baseFaq) live._baseFaq = live.faq || [];
  live.faq = [...kbToFaqEntries(entries), ...live._baseFaq];
  return true;
}

/** Boot-time hydration for every registered clinic. Never throws. */
export async function hydrateAllClinicsKb(store) {
  if (typeof store.listClinics !== 'function') return;
  for (const clinic of store.listClinics() || []) {
    try {
      await mergeTenantKb(store, clinic.id);
    } catch {
      /* a broken tenant must not block the others */
    }
  }
}
