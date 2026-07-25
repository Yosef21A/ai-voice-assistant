// P2-HUMANIZE hardening (from the adversarial reviews): the reply guardrail must
// catch invented prices in the corridor's real wording — Latin "dinars",
// prefix currency ($3000), Arabic-Indic digits, Arabic-script euro, spelled-out
// amounts — plus outcome promises and diagnoses in all four registers the
// corridor actually writes (AR script, Arabizi, FR, EN), while letting the
// tenant's own "from" figures and ordinary booking language through.
//
// Two properties are pinned deliberately:
//   · FIXED POINT — filterReply(filterReply(x)) === filterReply(x). The kept
//     sentences are delivered joined by a space, so a pattern split across
//     lines (LLM bullet lists) used to be invisible to the per-sentence scan
//     yet fully present in the delivered text.
//   · PRECISION — a violating line is dropped, not the whole reply, so the
//     clinic's real price survives next to an invented one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterReply,
  allowedNumbers,
  allowedSpelledMoney,
} from '../src/engine/humanize/guardrails.js';

const CLINIC = {
  name: 'Test Clinic',
  handoff: { phone: '+216 29 496 305' },
  pricing: {
    cardiology: { consultation_eur: 40, estimate_eur: [900, 3500] },
    dental: { consultation_eur: 30, estimate_eur: [300, 4000] },
  },
  workingHours: { mon: ['08:30', '17:30'] },
};

const clean = (t, lang = 'en') => filterReply(t, { clinic: CLINIC, lang });

/** Assert `text` trips a violation of `kind` and the offending text is gone. */
const flags = (text, kind, lang = 'en') => {
  const r = clean(text, lang);
  assert.ok(
    r.violations.some((v) => v.startsWith(kind)),
    `expected a ${kind} violation for ${JSON.stringify(text)}, got ${JSON.stringify(r.violations)}`
  );
  return r;
};

/** Assert `text` is delivered untouched. */
const passes = (text, lang = 'en') => {
  const r = notCensored(text, lang);
  assert.equal(r.text, text, 'clean text must be delivered verbatim');
  return r;
};

/**
 * Assert nothing was flagged. Used for multi-line inputs, where the delivered
 * text legitimately differs from the input: kept fragments are joined with a
 * space, so the line breaks do not survive.
 */
const notCensored = (text, lang = 'en') => {
  const r = clean(text, lang);
  assert.equal(
    r.violations.length,
    0,
    `unexpected censoring of ${JSON.stringify(text)}: ${JSON.stringify(r.violations)}`
  );
  return r;
};

// ── invented prices (all wordings the corridor actually uses) ────────────────

test('invented price: number-before-euro is stripped', () => {
  const r = clean('The full package is around 9999€ all in.');
  assert.ok(!r.text.includes('9999'));
  assert.ok(r.violations.some((v) => v.startsWith('price')));
});

test('invented price: Latin "dinars" (French/English corridor wording) is stripped', () => {
  const fr = clean("Le forfait complet est d'environ 3000 dinars tout compris.", 'fr');
  assert.ok(!fr.text.includes('3000'), 'French dinars caught');
  const en = clean('It will cost about 3000 dinars total.');
  assert.ok(!en.text.includes('3000'), 'English dinars caught');
});

test('invented price: prefix currency ($3000, €3200) is stripped', () => {
  assert.ok(!clean('The surgery is $3000.').text.includes('3000'));
  assert.ok(!clean('Environ €3200 pour la chirurgie.', 'fr').text.includes('3200'));
});

test('invented price: Arabic-Indic digits do not bypass the filter', () => {
  const r = clean('الجراحة تكلف ٩٩٩٩ دينار.', 'ar');
  assert.ok(!r.text.includes('٩٩٩٩'), 'Arabic-Indic price removed');
  assert.ok(r.violations.some((v) => v.startsWith('price')));
});

test('invented price: Arabic-script euro tokens (أورو / اورو / يورو) are caught', () => {
  for (const cur of ['أورو', 'اورو', 'يورو']) {
    const r = flags(`العملية تكلف 9999 ${cur}.`, 'price', 'ar');
    assert.ok(!r.text.includes('9999'), `${cur} price removed`);
  }
});

test('invented price: Arabic PLURAL dinar (دنانير) is caught, not just the singular', () => {
  const r = flags('العملية تكلف 9999 دنانير.', 'price', 'ar');
  assert.ok(!r.text.includes('9999'));
});

test('invented price: markdown emphasis and table pipes do not hide the figure', () => {
  // Gemini formats amounts. "**12000** euros" is not `NUM\s*CUR` until the
  // scan probe folds the noise away.
  assert.ok(!clean('The package is **12000** euros.').text.includes('12000'));
  assert.ok(!clean('| Chirurgie | 12000 | EUR |', 'fr').text.includes('12000'));
});

test('invented price: spelled-out amounts are caught in all four registers', () => {
  flags('The full package is three thousand euros all in.', 'price', 'en');
  flags('Le forfait est de trois mille dinars.', 'price', 'fr');
  flags('العملية تكلف ألف دينار.', 'price', 'ar');
  flags('El 3amaliya tekallef alf dinar.', 'price', 'ar');
});

// ── tenant's own prices pass ─────────────────────────────────────────────────

test('legit "from" price (array-bound estimate) passes through — not censored', () => {
  const r = clean('Dental implants start from 300€, with estimates up to 4000€.');
  assert.ok(r.text.includes('300'), 'lower bound kept');
  assert.ok(r.text.includes('4000'), 'upper bound kept');
  assert.equal(r.violations.length, 0);
});

test('allowedNumbers collects array bounds individually (900 AND 3500)', () => {
  const a = allowedNumbers(CLINIC);
  assert.ok(a.has(900) && a.has(3500) && a.has(40) && a.has(300) && a.has(4000));
  assert.ok(!a.has(9003500), 'array elements are not concatenated across the comma');
});

test('consultation figure passes through', () => {
  const r = clean('Cardiology consultation is about 40€.');
  assert.ok(r.text.includes('40'));
  assert.equal(r.violations.length, 0);
});

test("tenant's own figures survive the Arabic-script currency tokens", () => {
  passes('زراعة الأسنان من 900 أورو.', 'ar');
  passes('جراحة القلب من 900 أورو إلى 3500 أورو.', 'ar');
  passes('الاستشارة 40 يورو.', 'ar');
});

test('the clinic payment FAQ (currency words, no figure) is not a price violation', () => {
  passes(
    'Nous acceptons les especes (dinar tunisien ou euro), la carte bancaire et le virement.',
    'fr'
  );
  passes('نقبلوا الكاش (دينار تونسي أو أورو)، البطاقة البنكية، والتحويل البنكي.', 'ar');
});

test('spelled-out numbers that are NOT money pass (distance, percentages)', () => {
  passes('Le centre est a cent metres de la gare.', 'fr');
  passes('We are a hundred meters from the station.', 'en');
  passes('المسافة مية متر من العيادة.', 'ar');
});

test("a spelled price the tenant itself publishes is allow-listed, not censored", () => {
  const clinicWithSpelledPrice = {
    ...CLINIC,
    faq: [{ answer: { fr: 'Les implants dentaires demarrent a partir de trois cents euros.' } }],
  };
  const allowed = allowedSpelledMoney(clinicWithSpelledPrice);
  assert.ok(allowed.size > 0, 'the tenant spelled price is collected');
  const r = filterReply('Les implants demarrent a partir de trois cents euros.', {
    clinic: clinicWithSpelledPrice,
    lang: 'fr',
  });
  assert.equal(r.violations.length, 0, "the clinic's own spelled price passes");
  // …while a different spelled amount is still a violation.
  const bad = filterReply('Le forfait est de trois mille euros.', {
    clinic: clinicWithSpelledPrice,
    lang: 'fr',
  });
  assert.ok(bad.violations.some((v) => v.startsWith('price')));
});

// ── promises ─────────────────────────────────────────────────────────────────

test('"100%" promise is caught even before a space/end of line', () => {
  const r = clean('You will 100% recover fully.');
  assert.ok(!/100\s*%/.test(r.text));
  assert.ok(r.violations.some((v) => v.startsWith('promise')));
});

test('Arabic "١٠٠٪" promise is caught (digit + percent normalized)', () => {
  const r = clean('نجاحنا ١٠٠٪ مضمون.', 'ar');
  assert.ok(r.violations.some((v) => v.startsWith('promise')));
});

test('spelled-out hundred-percent is caught in all four registers', () => {
  flags('You will recover hundred percent.', 'promise', 'en');
  flags('The operation is one hundred percent safe.', 'promise', 'en');
  flags("L'operation reussit cent pour cent.", 'promise', 'fr');
  flags('العملية ناجحة مية بالمية.', 'promise', 'ar');
  flags('نسبة النجاح مئة في المئة.', 'promise', 'ar');
});

test('guarantee/risk promises are caught across inflections', () => {
  flags('There is zero risk.', 'promise', 'en');
  flags('There is no risk with this surgery.', 'promise', 'en');
  flags('There are no risks at all.', 'promise', 'en');
  flags('Nous garantissons le resultat.', 'promise', 'fr');
  flags('La clinique garantit un bon resultat.', 'promise', 'fr');
  flags('Notre taux de reussite est excellent.', 'promise', 'fr');
  flags('Our success rates are the best.', 'promise', 'en');
  flags('El 3amaliya bla khater.', 'promise', 'ar');
  flags('El 3amaliya bla makhater.', 'promise', 'ar');
});

test('"guaranteed" is a promise only when it qualifies an OUTCOME', () => {
  // Outcome + guaranteed → forbidden, in Arabic script and Arabizi.
  flags('النتيجة مضمونة.', 'promise', 'ar');
  flags('Ennajah madmoun m3ana.', 'promise', 'ar');
  flags('El natija madmouna.', 'promise', 'ar');
  // …but مضمون / madmoun is ordinary Derja for "confirmed / secured", which a
  // booking bot must stay able to say. A bare adjective is NOT a promise.
  passes('موعدك مضمون يوم الخميس.', 'ar');
  passes('الحجز مضمون، تنجم تجي.', 'ar');
  passes('Maw3edek madmoun nhar el khmis.', 'ar');
});

test('the word "risk" on its own is not a promise (risk disclosure stays sayable)', () => {
  passes('Our team will explain every risk to you.', 'en');
});

// ── diagnosis ────────────────────────────────────────────────────────────────

test('diagnosis assertion is stripped and the safe line is appended', () => {
  const r = clean('You probably have a serious heart disease, but we can help.');
  assert.ok(!/you probably have/i.test(r.text));
  assert.ok(r.text.length > 0, 'never silent');
});

test('Arabizi diagnosis assertions are stripped', () => {
  flags('3andek cancer, lazem tji fissa3.', 'diagnosis', 'ar');
  flags('Ya khouya 3andk saratan fel poumon.', 'diagnosis', 'ar');
  flags('Enti t3ani men marad fel qalb.', 'diagnosis', 'ar');
  flags('t3aniw men waram.', 'diagnosis', 'ar');
});

test('Arabizi "3andek" / "t3ani" without a disease word is ordinary conversation', () => {
  passes('3andek maw3ed nhar el jem3a fi 10h.', 'ar');
  passes('3andek chi hasasiya lel benj?', 'ar');
  passes('t3ani men chi haja?', 'ar');
});

// ── assembled-reply (fixed point) pass ───────────────────────────────────────

test('a pattern split across lines is caught — the reply is scanned as delivered', () => {
  // The per-sentence scan sees "Vous avez :" and "- un cancer…" separately;
  // neither matches, but the delivered join does.
  const r = clean('Vous avez :\n- un cancer du sein avance.', 'fr');
  assert.ok(
    r.violations.some((v) => v.startsWith('diagnosis')),
    'cross-line diagnosis caught'
  );
  assert.ok(!/cancer/i.test(r.text), 'the assertion is not delivered');
});

test('cross-line symptom list (the shape Gemini actually emits) is caught', () => {
  const r = clean(
    "D'apres vos symptomes, vous avez probablement :\n- une infection urinaire\n- une inflammation",
    'fr'
  );
  assert.ok(r.violations.some((v) => v.startsWith('diagnosis')));
});

// The assembled pass glues fragments only where the line break was FORMATTING
// inside one clause (dangling connector, or a line opening with a bullet /
// stray symbol). Two lines that each start a real sentence are probed with a
// terminator between them.
//
// That makes the fixed point hold for violating replies, but NOT universally:
// the delivered text joins lines with a space, so re-feeding an innocent
// two-line reply presents it as one sentence and the imprecise regex then
// flags it. Delivering that reply is still correct — the text asserts nothing —
// so the property is pinned only where it is meaningful, on the shapes a model
// actually emits. (Preserving the line breaks in the delivered text would make
// it universal; that is a separate change to the reply-assembly path.)
test('filterReply is a fixed point on the shapes a model actually emits', () => {
  const inputs = [
    ["D'apres vos symptomes, vous avez probablement :\n- une infection urinaire", 'fr'],
    ['Vous avez :\n- un cancer du sein avance.', 'fr'],
    ['Success:\n100\n%', 'en'],
    ['Nos tarifs :\n- Chirurgie : 12000 euros', 'fr'],
    ['Great! Which day works best for you?', 'en'],
  ];
  for (const [text, lang] of inputs) {
    const once = clean(text, lang);
    const twice = clean(once.text, lang);
    assert.equal(twice.text, once.text, `not a fixed point for ${JSON.stringify(text)}`);
    assert.equal(twice.violations.length, 0, 'the delivered text is itself clean');
  }
});

// A self-review of the two-pass rewrite found that a CHARACTER bound on the
// subject→disease gap was narrower than the `.*` it replaced: ordinary French
// clinical hedging runs well past 40 characters, so the hedged form — exactly
// what a model produces after a patient sends an X-ray — walked through. The
// gap must stay unbounded within a clause; only the sentence terminator bounds it.
test('hedged diagnosis is caught however long the hedge is', () => {
  const hedged = [
    "Vous avez, d'apres ce que vous decrivez et d'apres la radio, une infection au niveau de la molaire.",
    'Vous avez selon toute vraisemblance et d apres nos medecins un cancer.',
    "Bonjour ! Vous avez, d'apres les photos que vous nous avez envoyees, une infection.",
    'Vous avez une infection.',
  ];
  for (const text of hedged) flags(text, 'diagnosis', 'fr');
});

test('the assembled pass does not wipe two innocent independent lines', () => {
  // Each line is harmless; only a naive space-join makes them look like
  // "vous avez … infection".
  notCensored('Vous avez rendez-vous mardi\nSignalez toute infection en cours', 'fr');
  notCensored('باهي، عندك موعد\nالممرضة تستناك في الاستقبال\nمرحبا بيك في العيادة', 'ar');
});

test('Arabic disease roots are boundary-guarded — الممرضة ("the nurse") is not a diagnosis', () => {
  passes('عندك موعد مع الممرضة يوم الثلاثاء على 10:00', 'ar');
  passes('عندك موعد مع الممرض علي', 'ar');
  passes('عندك موعد في قسم المرضى', 'ar');
  // …while the real assertions still trip, definite article included.
  for (const text of ['عندك مرض في القلب', 'عندك المرض هذا', 'تعاني من التهاب حاد', 'عندك سرطان']) {
    flags(text, 'diagnosis', 'ar');
  }
});

test("a price RANGE of the clinic's own figures is not an invented price", () => {
  // Folding the dash to a space let NUM swallow "900 3500" as one bogus
  // 9003500 and censor the tenant's published range.
  passes('Pour la cardiologie, comptez 900-3500 € selon l intervention.', 'fr');
  passes('Dental work runs 300-4000 EUR depending on the treatment.', 'en');
});

test('promise registers the corridor actually writes (digit+word hybrids)', () => {
  flags('نسبة النجاح 100 بالمئة.', 'promise', 'ar');
  flags('النتيجة مضمونة 100.', 'promise', 'ar');
  flags('نسبة نجاح عالية جدا مضمونة.', 'promise', 'ar');
  flags('El 3amaliya madmouna 100 bel mia.', 'promise', 'ar');
});

test('precision: an invented row is dropped, the clinic\'s real figure survives', () => {
  const r = clean('Nos tarifs :\n- Consultation : 12000 euros\n- Cardio : 40 euros', 'fr');
  assert.ok(!r.text.includes('12000'), 'invented figure dropped');
  assert.ok(r.text.includes('40'), "the clinic's own figure kept");
  assert.ok(r.violations.some((v) => v.startsWith('price')));
});

// ── never silent ─────────────────────────────────────────────────────────────

test('a fully-clean reply is returned unchanged', () => {
  const r = clean('Great! Which day works best for you?');
  assert.equal(r.text, 'Great! Which day works best for you?');
  assert.equal(r.violations.length, 0);
});

test('a fully-stripped reply degrades to the safe line, never empty', () => {
  const r = clean('You have cancer. It costs 12345€. 100% guaranteed.', 'en');
  assert.ok(r.text.length > 0);
  assert.ok(!r.text.includes('12345'));
});
