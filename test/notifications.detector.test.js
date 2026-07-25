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

test('detectEmergency — Arabizi positives (corridor patients write Latin-script Arabic)', () => {
  const positives = [
    ['3andi wja3 fi sadri w ma najamtish ntnaffes', 'chest_pain'],
    ['sadri yewja3ni barcha', 'chest_pain'],
    ['nawba 9albiya', 'chest_pain'],
    ['di9 fi nefes', 'breathing'],
    ['5na9', 'breathing'],
    ['nazif ma ywa9efch', 'bleeding'],
    ['ma yfi9ch', 'unconscious'],
    ['tah 3al ard', 'unconscious'],
    ['3andi hasasiya chdida', 'allergic'],
    ['nheb nmout', 'self_harm'],
    ['n9tel rou7i', 'self_harm'],
    ['ntihar', 'self_harm'],
  ];
  for (const [text, category] of positives) {
    const r = detectEmergency(text, 'ar');
    assert.equal(r.hit, true, `Arabizi emergency MISSED: ${text}`);
    assert.equal(r.category, category, `wrong category for: ${text}`);
  }
});

// Every Arabizi entry that is a co-occurrence GROUP is exercised here — those
// are the entries most likely to break silently when someone edits a token list
// — plus the stroke category, where a false negative is costliest.
test('detectEmergency — Arabizi positives cover every category incl. stroke', () => {
  const positives = [
    ['3andha jalta dimaghiya', 'stroke'],
    ['fomm m3awej w ma yetkallemch', 'stroke'],
    ['3andi di9 fi sadri', 'chest_pain'],
    ['zab7a sadriya', 'chest_pain'],
    ['ma najjamtsh ntnaffes', 'breathing'],
    ['ykhne9 rou7ou', 'breathing'],
    ['taht fi ghaybouba', 'unconscious'],
    ['maghmi 3lih', 'unconscious'],
    ['ntfa5 wejhou', 'allergic'],
    ['sadma tahassousiya', 'allergic'],
    ['nzif ma yew9efch', 'bleeding'],
    ['eddem sayel barcha', 'bleeding'],
    ['ma3adch nheb n3ich', 'self_harm'],
  ];
  for (const [text, category] of positives) {
    const r = detectEmergency(text, 'ar');
    assert.equal(r.hit, true, `Arabizi emergency MISSED: ${text}`);
    assert.equal(r.category, category, `wrong category for: ${text}`);
  }
});

test('detectEmergency — Arabizi negatives stay clean (co-occurrence guards ambiguous roots)', () => {
  const negatives = [
    'nheb nahjez maw3ed 3and doktor el 9alb', // cardiologist booking — 9alb alone
    'tajmil sadr', // breast cosmetic — sadr without a pain root
    'ta7lil dam routine', // blood test — dam without a flow root
    'chnowa el prix mte3 3amaliya', // price question
    'nheb na3mel 3amaliya tajmil', // cosmetic surgery request
    'ma3andi ma nheb', // "ma" appears but no co-occurring emergency root
  ];
  for (const text of negatives) {
    const r = detectEmergency(text, 'ar');
    assert.equal(r.hit, false, `Arabizi false positive on: ${text} (${r.category})`);
  }
});

// The Arabizi tokens are everyday Tunisian words: 'dam' is a blood TEST, 'di9'
// is a shortage ("di9 el wa9t" = short of time), 'sadr' is the breast in
// cosmetic traffic, 'nheb' opens most booking messages. Co-occurrence ALONE is
// not enough — without a distance bound these fire on ordinary clinic traffic.
test('detectEmergency — Arabizi groups require PROXIMITY, not just co-occurrence', () => {
  const negatives = [
    'di9 el wa9t 3andi, nheb rendez-vous tajmil sadr fissa3', // di9(time) … sadr
    'di9 fel budget mte3i, 3andi 3amaliya sadr', // di9(money) … sadr
    'nheb na3ref el prix mte3 tajmil el sadr, ma nheb 7atta haja okhra', // sadr … no pain root
    'el wja3 mte3 senni khfif, w 3andi rendez-vous tajmil sadr chhar jay', // wja3(tooth) far from sadr
    '3andi ta7lil dam, el natija sayel wala la?', // lab marker suppresses dam+sayel
    'nheb na3mel ta7lil dam w el resultat mte3 sayel synovial',
    'ma3andich flous barcha, nheb na3ref waa9tech yfi9 el doktor', // negation + "wakes up"
    'wa9tech yfi9 el doktor mel 3amaliya? ma na3refch',
    'mesh chirurgie, nheb hernia mesh operation', // 'mesh' is also a clinical term
    'nheb nahjez ghodwa, ma nheb chay okhra', // 'ma' + 'nheb' are function words
    'nheb na3ref 3al hasasiya lel benj, ma3andich chdida', // allergy inquiry, tokens apart
  ];
  for (const text of negatives) {
    const r = detectEmergency(text, 'ar');
    assert.equal(r.hit, false, `proximity false positive on: ${text} (${r.category}/${r.keyword})`);
  }
});

// Proximity is measured as the GAP between the matched tokens, not the total
// span — a span bound punishes long keywords and, as a self-review found, one
// ordinary intensifier ("kbir barcha") was enough to push a real chest-pain
// report out of range. False negatives here are the expensive direction.
test('detectEmergency — intensifiers and adverbs do not push a real emergency out of range', () => {
  const stillFires = [
    ['3andi wja3 kbir barcha fi sadri', 'chest_pain'],
    ['3andi wja3 9wi barcha fi sadri', 'chest_pain'],
    ['wja3 chadid fi west sadri', 'chest_pain'],
    ['3andi wja3 men el lil fi sadri', 'chest_pain'],
    ['3andi di9 kbir barcha fi sadri', 'chest_pain'],
    ['3andou di9 kbir fi tanaffos', 'breathing'],
    ['hasasiya mte3i chdida barcha', 'allergic'],
  ];
  for (const [text, category] of stillFires) {
    const r = detectEmergency(text, 'ar');
    assert.equal(r.hit, true, `intensifier lost a true positive: ${text}`);
    assert.equal(r.category, category, `wrong category for: ${text}`);
  }
});

test('detectEmergency — proximity bound still fires on the real collocation', () => {
  // The same roots, close together, ARE the emergency. A distance bound must
  // not cost us a true positive.
  for (const [text, category] of [
    ['3andi di9 kbir fi sadri', 'chest_pain'],
    ['eddem ma ywa9efch', 'bleeding'],
    ['tah 3al ard w ma yfi9ch', 'unconscious'],
    ['nheb nmout tawa', 'self_harm'],
  ]) {
    const r = detectEmergency(text, 'ar');
    assert.equal(r.hit, true, `proximity bound lost a true positive: ${text}`);
    assert.equal(r.category, category, `wrong category for: ${text}`);
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
