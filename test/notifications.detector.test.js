// Detector unit tests (P1-E) — cover src/notifications/detector.js AS IT EXISTS.
//
// Two safety/revenue-critical classifiers:
//   • detectEmergency(text, lang) — AR (incl. Libyan colloquial) / FR / EN
//     positives + the tricky negatives the tables were designed NOT to trip
//     (ambiguous روots: صدر/breast, حساسية/allergy, bare "douleur").
//   • isHotLead(engineResult, tenantConfig, text, {waId}) — pricing on a
//     high-value specialty, foreign (+218) travel intake, stated foreign origin,
//     and the negatives (completed booking, low-value specialty, home number).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectEmergency,
  isHotLead,
  classifyOrigin,
  normalizeArabic,
  normalizeLatin,
} from '../src/notifications/detector.js';

const CLINICS = JSON.parse(readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8')).clinics;
const EL_AMEN = CLINICS.find((c) => c.id === 'el-amen-sousse'); // country: Tunisia (home 216)

// ── emergency: Arabic (incl. Libyan/Tunisian colloquial forms) ────────────────
test('detectEmergency — Arabic positives (fus7a + Libyan colloquial)', () => {
  const cases = [
    ['عندي نزيف قوي برشة', 'bleeding'],
    ['الدم ما يوقفش خلاص', 'bleeding'], // Libyan colloquial
    ['عندي وجع في صدري من الصباح', 'chest_pain'], // وجع + صدر co-occurrence
    ['يوجعني صدري و نلهث', 'chest_pain'],
    ['ابني ما يتنفسش مليح', 'breathing'], // colloquial "can't breathe"
    ['عندي ضيق في التنفس', 'breathing'],
    ['مغمى عليه ومايفيقش', 'unconscious'], // colloquial "won't wake up"
    ['حبيبتي طاح ع الارض فجأة', 'unconscious'],
    ['نحب ننتحر ما عادش نحب نعيش', 'self_harm'],
  ];
  for (const [text, category] of cases) {
    const r = detectEmergency(text, 'ar');
    assert.equal(r.hit, true, `expected AR emergency hit for: ${text}`);
    assert.equal(r.category, category, `wrong category for: ${text}`);
  }
});

// ── emergency: French ─────────────────────────────────────────────────────────
test('detectEmergency — French positives', () => {
  const cases = [
    ["j'ai une forte douleur thoracique", 'chest_pain'],
    ['je crois que je fais une crise cardiaque', 'chest_pain'],
    ['il saigne abondamment, aidez-moi', 'bleeding'],
    ['je ne peux pas respirer', 'breathing'],
    ['mon mari est inconscient', 'unconscious'],
    ['choc anaphylactique, sa gorge gonfle', 'allergic'],
  ];
  for (const [text, category] of cases) {
    const r = detectEmergency(text, 'fr');
    assert.equal(r.hit, true, `expected FR emergency hit for: ${text}`);
    assert.equal(r.category, category, `wrong category for: ${text}`);
  }
});

// ── emergency: English ────────────────────────────────────────────────────────
test('detectEmergency — English positives', () => {
  const cases = [
    ['I have really bad chest pain', 'chest_pain'],
    ['this feels like a heart attack', 'chest_pain'],
    ['she is bleeding a lot and it wont stop', 'bleeding'],
    ['I cant breathe properly', 'breathing'],
    ['he passed out on the floor', 'unconscious'],
    ['severe allergic reaction, throat closing', 'allergic'],
  ];
  for (const [text, category] of cases) {
    const r = detectEmergency(text, 'en');
    assert.equal(r.hit, true, `expected EN emergency hit for: ${text}`);
    assert.equal(r.category, category, `wrong category for: ${text}`);
  }
});

// ── emergency: the deliberately-hard NEGATIVES ────────────────────────────────
test('detectEmergency — tricky negatives do NOT trip (guardrail against false alarms)', () => {
  const negatives = [
    ['pas de douleur, tout va bien', 'fr'], // no bare "douleur" keyword
    ['je veux une consultation de cardiologie', 'fr'], // cardiology inquiry, not chest pain
    ['aucun saignement pour le moment', 'fr'], // "saignement" alone is not a keyword
    ['how much for a breast augmentation?', 'en'], // breast ≠ chest
    ['do you treat allergies in general?', 'en'], // allergy inquiry, not anaphylaxis
    ['I want to book a chest x-ray consultation', 'en'], // "chest" alone must not fire
    ['نحب نعمل عملية تجميل صدر', 'ar'], // breast cosmetic surgery — صدر alone, no acute marker
    ['عندي شوية حساسية من الغبار', 'ar'], // mild allergy — no شديد/خطير marker
    ['نحب نحجز موعد عند طبيب القلب', 'ar'], // cardiology booking, قلب without acute marker
  ];
  for (const [text, lang] of negatives) {
    const r = detectEmergency(text, lang);
    assert.equal(r.hit, false, `false positive emergency on: ${text} (${r.category})`);
  }
});

test('detectEmergency — empty / whitespace is a clean miss', () => {
  assert.equal(detectEmergency('', 'fr').hit, false);
  assert.equal(detectEmergency('   ', 'ar').hit, false);
  assert.equal(detectEmergency(undefined).hit, false);
});

test('normalizers fold script correctly (sanity for matching)', () => {
  assert.equal(normalizeLatin("J'AI Mal"), ' jai mal ');
  assert.ok(normalizeArabic('صُدْرِي').includes('صدري'));
});

// ── hot-lead: origin classifier ───────────────────────────────────────────────
test('classifyOrigin — foreign vs home number', () => {
  assert.equal(classifyOrigin('218910000001', EL_AMEN).foreign, true); // Libya +218
  assert.equal(classifyOrigin('218910000001', EL_AMEN).country, 'Libya');
  assert.equal(classifyOrigin('21620000000', EL_AMEN).foreign, false); // Tunisia home
  assert.equal(classifyOrigin('', EL_AMEN).foreign, false);
});

// ── hot-lead: positives ───────────────────────────────────────────────────────
test('isHotLead — pricing on a high-value specialty', () => {
  const r = isHotLead(
    { intent: 'pricing_quote' },
    EL_AMEN,
    'bonjour, combien coûte une rhinoplastie ?',
    { waId: '21620000000' }
  );
  assert.equal(r.hot, true);
  assert.equal(r.reason, 'pricing_high_value');
  assert.equal(r.procedure, 'cosmetic_surgery');
});

test('isHotLead — foreign (+218) travel/booking intake', () => {
  const r = isHotLead(
    { intent: 'book_appointment' },
    EL_AMEN,
    'I want to book an appointment',
    { waId: '218910000001' } // Libyan number → medical-tourism prospect
  );
  assert.equal(r.hot, true);
  assert.equal(r.reason, 'foreign_travel_intake');
  assert.equal(r.country, 'Libya');
});

test('isHotLead — explicit stated foreign origin', () => {
  const r = isHotLead(
    { intent: 'faq' },
    EL_AMEN,
    'I am coming from Benghazi, Libya for a knee operation',
    { waId: undefined }
  );
  assert.equal(r.hot, true);
  assert.equal(r.reason, 'stated_foreign_origin');
  assert.equal(r.country, 'Libya');
});

// ── hot-lead: negatives ───────────────────────────────────────────────────────
test('isHotLead — negatives (completed booking, low-value, home number)', () => {
  // Completed booking is covered by the booking alert, never a "lead".
  assert.equal(
    isHotLead({ intent: 'book_appointment', appointment: { ref: 'X' } }, EL_AMEN, 'merci', {
      waId: '218910000001',
    }).hot,
    false
  );
  // Pricing on a non-high-value specialty (dental is not in the default set).
  assert.equal(
    isHotLead({ intent: 'pricing_quote' }, EL_AMEN, 'prix dentaire svp', { waId: '21620000000' }).hot,
    false
  );
  // Booking from a home (Tunisian) number with no foreign signal.
  assert.equal(
    isHotLead({ intent: 'book_appointment' }, EL_AMEN, 'je veux un rendez-vous', {
      waId: '21620000000',
    }).hot,
    false
  );
});
