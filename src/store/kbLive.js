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

// Function words in the corridor's three languages. Keeping them as matchFaq
// keywords lets a trained entry hijack ANY question that contains 'est'/'que'/
// 'vous' (matchFaq scores by substring, and KB entries win ties), which both
// serves wrong answers AND stops genuinely-unknown questions from ever being
// captured again (the loop silently self-poisons). Content words only.
const STOPWORDS = new Set([
  // fr
  'est', 'que', 'qui', 'quoi', 'vous', 'nous', 'les', 'des', 'une', 'ils', 'elle', 'elles',
  'pour', 'avec', 'dans', 'sur', 'par', 'pas', 'peux', 'peut', 'faites', 'faire', 'avez',
  'etes', 'votre', 'vos', 'notre', 'nos', 'mon', 'mes', 'moi', 'toi', 'ton', 'tes', 'ceci',
  'cela', 'comment', 'combien', 'quand', 'quel', 'quelle', 'quels', 'quelles', 'chez', 'aussi',
  // en
  'the', 'you', 'your', 'yours', 'have', 'has', 'are', 'was', 'does', 'did', 'can', 'could',
  'what', 'how', 'when', 'where', 'who', 'why', 'much', 'many', 'with', 'for', 'and', 'this',
  'that', 'there', 'about', 'any',
  // ar/tn (post-normalizeQuestion: lowercased, tashkeel stripped)
  'ماذا', 'كيف', 'متى', 'اين', 'أين', 'على', 'انا', 'أنا', 'انت', 'أنت', 'انتم', 'هذا',
  'هذه', 'ذلك', 'عند', 'عندكم', 'عندك', 'لديكم', 'قداش', 'شنو', 'شني', 'علاش', 'وين',
  'كيفاش', 'نجم', 'ننجم', 'تنجم', 'نجمت', 'باش', 'الي', 'اللي', 'ماهو', 'ماهي',
]);

/** Derive matchFaq keywords from a question when the entry carries none. */
export function deriveKeywords(question) {
  return normalizeQuestion(question)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
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

/**
 * Persisted tenant config (Settings/wizard saves land in the tenants
 * collection) → live clinic objects. Without this, every owner edit — persona,
 * hours, reminder toggles, quiet hours — silently REVERTED to the clinics.json
 * seed on restart: PUT /api/tenant patches the live object, but boot rebuilt it
 * from the seed alone (V2 review finding). Owner edits win over seed values;
 * faq/_baseFaq never ride along (the KB merge below owns those).
 */
export async function hydrateTenantConfigs(store) {
  if (typeof store.listClinics !== 'function' || typeof store.tenants?.getById !== 'function') return;
  for (const clinic of store.listClinics() || []) {
    try {
      const t = await store.tenants.getById(clinic.id);
      if (t?.config && typeof t.config === 'object') {
        const { faq, _baseFaq, ...cfg } = t.config;
        Object.assign(clinic, cfg);
      }
    } catch {
      /* a broken tenant must not block the others */
    }
  }
}

/** Boot-time hydration for every registered clinic. Never throws. */
export async function hydrateAllClinicsKb(store) {
  if (typeof store.listClinics !== 'function') return;
  // Config first (owner edits win over the seed), THEN the KB merge — it
  // snapshots _baseFaq off the hydrated clinic.
  await hydrateTenantConfigs(store);
  for (const clinic of store.listClinics() || []) {
    try {
      await mergeTenantKb(store, clinic.id);
    } catch {
      /* a broken tenant must not block the others */
    }
  }
}
