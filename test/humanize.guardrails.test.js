// P2-HUMANIZE hardening (from the adversarial review): the reply guardrail must
// catch invented prices in the corridor's real wording — Latin "dinars",
// prefix currency ($3000), Arabic-Indic digits, and "100%" promises — while
// letting the tenant's own "from" figures through, including array-bound
// estimates that a naive JSON scan used to censor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterReply, allowedNumbers } from '../src/engine/humanize/guardrails.js';

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

// ── promises & diagnosis ─────────────────────────────────────────────────────

test('"100%" promise is caught even before a space/end of line', () => {
  const r = clean('You will 100% recover fully.');
  assert.ok(!/100\s*%/.test(r.text));
  assert.ok(r.violations.some((v) => v.startsWith('promise')));
});

test('Arabic "١٠٠٪" promise is caught (digit + percent normalized)', () => {
  const r = clean('نجاحنا ١٠٠٪ مضمون.', 'ar');
  assert.ok(r.violations.some((v) => v.startsWith('promise')));
});

test('diagnosis assertion is stripped and the safe line is appended', () => {
  const r = clean('You probably have a serious heart disease, but we can help.');
  assert.ok(!/you probably have/i.test(r.text));
  assert.ok(r.text.length > 0, 'never silent');
});

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
