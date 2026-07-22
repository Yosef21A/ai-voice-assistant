// P2-HUMANIZE §3 correctness: Arabic-Indic digit normalization at ingest and
// the F4 datetime fix — a bare hour next to a weekday must be parsed, and any
// auto-shifted slot must be re-stated at the recap (adjustment transparency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createEngine } from '../src/engine/index.js';
import { MockProvider } from '../src/llm/mockProvider.js';
import { normalizeDigits } from '../src/engine/text.js';
import { parseDateTimeRequest } from '../src/engine/datetime.js';

const NOW = new Date(2026, 7, 2, 9, 0, 0); // Sunday 02 Aug 2026, 09:00

function freshEngine() {
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-test-${randomUUID()}`);
  const store = createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
  const engine = createEngine({ store, provider: new MockProvider(), config: base });
  return { store, engine };
}

async function drive(engine, { from, phoneNumberId }, script) {
  let last;
  for (const text of script) {
    last = await engine.handleMessage(
      { channel: 'simulate', from, text, phoneNumberId, messageId: 'm', timestamp: NOW.getTime() },
      { now: NOW }
    );
  }
  return last;
}

// ── normalizeDigits ──────────────────────────────────────────────────────────

test('normalizeDigits maps Arabic-Indic digits to ASCII', () => {
  assert.equal(normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
});

test('normalizeDigits maps Eastern Arabic-Indic (Persian) digits to ASCII', () => {
  assert.equal(normalizeDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
});

test('normalizeDigits handles mixed scripts and leaves other text intact', () => {
  assert.equal(normalizeDigits('اثنين ١٠ et ۵ à 7h'), 'اثنين 10 et 5 à 7h');
});

test('normalizeDigits is idempotent and null-safe', () => {
  const once = normalizeDigits('٣ مساء');
  assert.equal(normalizeDigits(once), once);
  assert.equal(normalizeDigits(null), '');
  assert.equal(normalizeDigits(undefined), '');
});

// ── parseDateTimeRequest (F4) ────────────────────────────────────────────────

test('F4: bare Arabic-Indic hour next to a weekday is parsed ("اثنين ١٠")', () => {
  const req = parseDateTimeRequest('اثنين ١٠', NOW);
  assert.ok(req.date, 'weekday resolved');
  assert.equal(new Date(req.date.y, req.date.mo, req.date.d).getDay(), 1, 'Monday');
  assert.equal(req.hour, 10);
  assert.equal(req.minute, 0);
});

test('bare hour with a relative day is parsed ("غدا ٣ مساء" → 15:00)', () => {
  const req = parseDateTimeRequest('غدا ٣ مساء', NOW);
  assert.ok(req.date);
  assert.equal(req.hour, 15, 'مساء forces PM');
});

test('small bare hour without AM/PM assumes the afternoon ("الخميس 3" → 15:00)', () => {
  const req = parseDateTimeRequest('الخميس 3', NOW);
  assert.equal(req.hour, 15);
});

test('a morning-range bare hour stays as given ("اثنين ١٠" is 10:00, not 22:00)', () => {
  const req = parseDateTimeRequest('اثنين ١٠', NOW);
  assert.equal(req.hour, 10);
});

test('an ISO date alone never leaks its digits into the hour', () => {
  const req = parseDateTimeRequest('2026-08-10', NOW);
  assert.ok(req.date);
  assert.equal(req.date.d, 10);
  assert.equal(req.hour, null, 'no hour invented from the date digits');
});

test('explicit separator forms are unchanged ("lundi 10h30")', () => {
  const req = parseDateTimeRequest('lundi 10h30', NOW);
  assert.equal(req.hour, 10);
  assert.equal(req.minute, 30);
});

test('a lone number with no date and no time-word is still ignored', () => {
  const req = parseDateTimeRequest('10', NOW);
  assert.equal(req.hour, null);
  assert.equal(req.date, null);
});

// ── end-to-end classic booking (F4 replay) ───────────────────────────────────

test('F4 replay: "اثنين ١٠" books Monday 10:00, not the opening slot', async () => {
  const { store, engine } = freshEngine();
  const id = { from: '218944444444', phoneNumberId: '1000000001' };
  await drive(engine, id, [
    'نحب نحجز موعد',
    'امراض القلب',
    'اثنين ١٠',
    'بعبوص خشين',
    'طرابلس',
    '29496305',
    'نعم',
  ]);
  const a = store.listAppointments()[0];
  assert.ok(a, 'appointment created');
  const when = new Date(a.datetimeISO);
  assert.equal(when.getDay(), 1, 'Monday');
  assert.equal(when.getHours(), 10, 'requested hour honored — NOT silently 08:30');
  assert.equal(when.getMinutes(), 0);
  assert.equal(a.datetimeAdjusted, false, 'nothing was adjusted, nothing to disclose');
});

test('adjustment transparency: shifted slot is re-stated in the recap', async () => {
  const { engine } = freshEngine();
  const id = { from: '218955555555', phoneNumberId: '1000000001' };
  // El Amen is closed on Sunday → the request must shift and SAY so.
  const last = await drive(engine, id, [
    'نحب نحجز موعد',
    'امراض القلب',
    'الاحد ١٠',
    'بعبوص خشين',
    'طرابلس',
    '29496305',
  ]);
  const recap = last.replies.join('\n');
  assert.ok(recap.includes('⚠️'), 'recap carries the adjustment warning');
  assert.ok(recap.includes('نراجعو الحجز'), 'recap is the confirm summary');
});

test('adjustment note appears at the datetime step too (existing behavior kept)', async () => {
  const { engine } = freshEngine();
  const id = { from: '218966666666', phoneNumberId: '1000000001' };
  const last = await drive(engine, id, ['book appointment', 'cardiology', 'Sunday at 20:00']);
  assert.ok(
    last.replies.some((r) => r.includes('⚠️')),
    'immediate adjustment disclosure on collection'
  );
});
