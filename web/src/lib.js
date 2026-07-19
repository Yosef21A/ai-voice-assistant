// Shared pure helpers + static catalogs for the dashboard. No React here.

// Arabic script detection → per-message RTL in the inbox / previews.
const AR_RE = /[؀-ۿݐ-ݿ]/;
export const isArabicText = (s) => AR_RE.test(String(s || ''));
export const dirOf = (s) => (isArabicText(s) ? 'rtl' : 'ltr');

// The dashboard's own language never dictates a message's direction: a French
// operator still sees Arabic patient text right-aligned, and vice-versa.
export function detectLang(s) {
  if (isArabicText(s)) return 'ar';
  return 'fr';
}

const pad = (n) => String(n).padStart(2, '0');

/** HH:MM in the clinic's local reading (kept simple + deterministic). */
export function fmtTime(iso, lang = 'fr') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-TN' : lang === 'en' ? 'en-GB' : 'fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

/** Localized long day label, e.g. "lundi 21 juillet". */
export function fmtDay(iso, lang = 'fr') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-TN' : lang === 'en' ? 'en-GB' : 'fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(d);
  } catch {
    return d.toDateString();
  }
}

/** "just now" / "3m" / "2h" / "5d" — compact relative stamp for lists. */
export function fmtAgo(iso, lang = 'fr') {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60000);
  if (m < 1) return { fr: "à l'instant", ar: 'الآن', en: 'now' }[lang] || 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}${{ fr: 'j', ar: 'ي', en: 'd' }[lang] || 'd'}`;
}

/** YYYY-MM-DD key for grouping appointments by calendar day. */
export const dayKey = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : 'unknown');

export const csvList = (arr) => (Array.isArray(arr) ? arr.join(', ') : '');
export const parseList = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Initials for the avatar chip. */
export function initials(name, fallback = '?') {
  const s = String(name || '').trim();
  if (!s) return fallback;
  const parts = s.split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || fallback;
}

// ── specialty catalog ───────────────────────────────────────────────────────
// The wizard/settings profile checklist. ids match data/clinics.json + i18n
// `spec.*`; labels here are the fallback used when a tenant enables a specialty
// its seed config didn't already carry (so the engine still gets a labelled row).
export const SPECIALTY_CATALOG = [
  { id: 'dental', ar: 'طب الأسنان', fr: 'Dentaire', en: 'Dental' },
  { id: 'cosmetic_surgery', ar: 'جراحة التجميل', fr: 'Chirurgie esthétique', en: 'Cosmetic surgery' },
  { id: 'cardiology', ar: 'أمراض القلب', fr: 'Cardiologie', en: 'Cardiology' },
  { id: 'orthopedics', ar: 'جراحة العظام', fr: 'Orthopédie', en: 'Orthopedics' },
  { id: 'fertility', ar: 'علاج العقم', fr: 'Fertilité (PMA)', en: 'Fertility (IVF)' },
  { id: 'ophthalmology', ar: 'طب العيون', fr: 'Ophtalmologie', en: 'Ophthalmology' },
  { id: 'dermatology', ar: 'الأمراض الجلدية', fr: 'Dermatologie', en: 'Dermatology' },
  { id: 'general', ar: 'الطب العام', fr: 'Médecine générale', en: 'General medicine' },
];
const SPEC_BY_ID = Object.fromEntries(SPECIALTY_CATALOG.map((s) => [s.id, s]));

/** Localized label for a specialty id (from its config object or the catalog). */
export function specialtyLabel(spec, lang) {
  if (spec && spec.labels) return spec.labels[lang] || spec.labels.fr || spec.id;
  const id = typeof spec === 'string' ? spec : spec?.id;
  const c = SPEC_BY_ID[id];
  return (c && c[lang]) || (c && c.fr) || id || '';
}

/** Turn a catalog id into the clinic-shaped specialty object the engine reads. */
export const specialtyObject = (id) => ({
  id,
  labels: { ar: SPEC_BY_ID[id]?.ar || id, fr: SPEC_BY_ID[id]?.fr || id, en: SPEC_BY_ID[id]?.en || id },
});

// ── knowledge-base specialty templates ──────────────────────────────────────
// One click pre-loads REAL trilingual Q&As the owner then edits. Kept concise
// (the pilot ships a solid seed per specialty rather than the full 25 in spec).
const T = {
  dental: [
    { q: 'Combien coûte un implant dentaire ?', a: {
      ar: 'سعر زرع الأسنان يبدأ من مستوى معيّن ويتحدّد نهائياً بعد الفحص والأشعة. نعطيك عرضاً واضحاً قبل البدء.',
      fr: 'Le prix d’un implant démarre à partir d’un tarif de base et se confirme après examen et radio. Vous recevez un devis clair avant de commencer.',
      en: 'An implant starts from a base price and is confirmed after an exam and X-ray. You get a clear quote before we begin.' } },
    { q: 'Combien de temps dure la pose d’un implant ?', a: {
      ar: 'عادةً زيارتان: تركيب الزرعة ثم التاج بعد الالتئام. الإقامة القصيرة للعلاج السريع ممكنة 2–3 أيام.',
      fr: 'En général deux visites : pose de l’implant puis la couronne après cicatrisation. Un séjour court de 2–3 jours est possible pour les soins rapides.',
      en: 'Usually two visits: placing the implant, then the crown after healing. A short 2–3 day stay works for quick treatments.' } },
    { q: 'La pose est-elle douloureuse ?', a: {
      ar: 'العلاج يتم تحت تخدير موضعي فلا تحسّ بألم أثناءه، ونصف لك مسكّنات بسيطة بعده.',
      fr: 'L’acte se fait sous anesthésie locale, sans douleur pendant l’intervention ; des antalgiques simples sont prescrits après.',
      en: 'The procedure is done under local anaesthesia, painless during treatment; simple painkillers are prescribed after.' } },
  ],
  cosmetic_surgery: [
    { q: 'Quel est le prix d’une rhinoplastie ?', a: {
      ar: 'سعر عملية تجميل الأنف يبدأ من تسعيرة أساسية ويتأكّد بعد الاستشارة مع الجرّاح. الرقم النهائي حسب حالتك.',
      fr: 'Le prix d’une rhinoplastie démarre à partir d’un tarif de base et se confirme après la consultation avec le chirurgien.',
      en: 'A rhinoplasty starts from a base price and is confirmed after the consultation with the surgeon.' } },
    { q: 'Combien de jours dois-je rester en Tunisie ?', a: {
      ar: 'أغلب عمليات التجميل تتطلّب 6 إلى 8 أيام مع فترة النقاهة والمتابعة قبل السفر.',
      fr: 'La plupart des interventions esthétiques demandent 6 à 8 jours avec convalescence et suivi avant le départ.',
      en: 'Most cosmetic procedures need 6 to 8 days including recovery and a check before you fly home.' } },
  ],
  cardiology: [
    { q: 'Faites-vous des bilans cardiaques complets ?', a: {
      ar: 'نعم، نوفّر تخطيط القلب، الإيكو، واختبار الجهد ضمن بيلان كامل. الاستشارة تبدأ من تسعيرة أساسية.',
      fr: 'Oui : ECG, échographie et test d’effort dans un bilan complet. La consultation démarre à partir d’un tarif de base.',
      en: 'Yes: ECG, echo and stress test in a full work-up. The consultation starts from a base price.' } },
  ],
  orthopedics: [
    { q: 'Posez-vous des prothèses de hanche et de genou ?', a: {
      ar: 'نعم، نجري تركيب مفاصل الورك والركبة مع فريق جراحة العظام. الإقامة تقارب 5–10 أيام مع النقاهة.',
      fr: 'Oui, nous posons des prothèses de hanche et de genou. Le séjour est d’environ 5–10 jours avec la convalescence.',
      en: 'Yes, we fit hip and knee replacements. The stay is about 5–10 days including recovery.' } },
  ],
  fertility: [
    { q: 'Proposez-vous la FIV (PMA) ?', a: {
      ar: 'نعم، نقدّم أطفال الأنابيب والتلقيح مع متابعة كاملة. برنامج العلاج يُحدَّد بعد التحاليل الأولية.',
      fr: 'Oui, nous proposons la FIV et l’insémination avec un suivi complet. Le protocole est défini après le bilan initial.',
      en: 'Yes, we offer IVF and insemination with full follow-up. The protocol is set after the initial work-up.' } },
  ],
  ophthalmology: [
    { q: 'Faites-vous la chirurgie LASIK ?', a: {
      ar: 'نعم، نجري تصحيح النظر بالليزك بعد فحص دقيق للعين. أغلب الحالات تحتاج يوماً أو يومين فقط.',
      fr: 'Oui, nous réalisons le LASIK après un examen précis de l’œil. La plupart des cas ne nécessitent qu’un ou deux jours.',
      en: 'Yes, we perform LASIK after a precise eye exam. Most cases need only one or two days.' } },
  ],
};

/** KB-entry payloads for a specialty template (source:'template'). */
export function templateEntries(specId) {
  const list = T[specId] || [];
  return list.map((row, i) => ({
    key: `tpl_${specId}_${i + 1}`,
    question: row.q,
    answer: row.a,
    keywords: [],
    source: 'template',
    status: 'active',
  }));
}

export const hasTemplate = (specId) => (T[specId] || []).length > 0;
