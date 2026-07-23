// Regressions for the adversarial-review hardening pass (non-guardrail fixes):
// F9 stale-flow cancel, weekday-independent afternoon inference, GDPR patient
// erase, and never-repeat retry state isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createEngine } from '../src/engine/index.js';
import { MockProvider } from '../src/llm/mockProvider.js';
import { parseDateTimeRequest } from '../src/engine/datetime.js';

const NOW = new Date(2026, 7, 2, 9, 0, 0);

function freshEngine(mode = 'classic') {
  const config = getConfig({ conversationMode: mode });
  const runtimeDir = path.join(os.tmpdir(), `omen-rev-${randomUUID()}`);
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir, reset: true });
  const engine = createEngine({ store, provider: new MockProvider(), config });
  return { store, engine };
}

const send = (engine, from, text, now = NOW) =>
  engine.handleMessage(
    { channel: 'simulate', from, text, phoneNumberId: '1000000001', messageId: 'm', timestamp: now.getTime() },
    { now }
  );

// ── F9 stale-flow cancel (zombie flow) ───────────────────────────────────────

test('F9: cancel on a stale booking flow clears it — not "nothing to cancel"', async () => {
  const { store, engine } = freshEngine();
  const from = '218970000001';
  await send(engine, from, 'نحب نحجز موعد');
  await send(engine, from, 'أسنان'); // specialty locked

  const LATER = new Date(2026, 7, 5, 9, 0, 0); // >2h later → stale
  const out = await send(engine, from, 'إلغاء', LATER);
  assert.equal(out.intent, 'cancel');
  assert.ok(!out.reply.includes('ما فماش حجز جاري'), 'not the nothing-to-cancel line');
  const convo = store.getConversation('el-amen-sousse', from);
  assert.equal(convo.state, null, 'zombie flow cleared');
});

test('F9: handoff on a stale flow is honored as an interrupt', async () => {
  const { engine } = freshEngine();
  const from = '218970000002';
  await send(engine, from, 'نحب نحجز موعد');
  await send(engine, from, 'أسنان');
  const LATER = new Date(2026, 7, 5, 9, 0, 0);
  const out = await send(engine, from, 'موظف', LATER);
  assert.equal(out.intent, 'human_handoff');
});

// ── weekday-independent afternoon inference (am inside "samedi") ──────────────

test('bare afternoon hour parses the SAME across weekdays (samedi vs lundi)', () => {
  const sat = parseDateTimeRequest('samedi 3', NOW);
  const mon = parseDateTimeRequest('lundi 3', NOW);
  assert.equal(sat.hour, mon.hour, '"am" inside "samedi" no longer skews the meridiem');
  assert.equal(sat.hour, 15, 'bare 3 → 15:00 afternoon inference');
});

test('an explicit "am" still forces the morning', () => {
  const r = parseDateTimeRequest('lundi 3 am', NOW);
  assert.equal(r.hour, 3);
});

// ── GDPR erase takes the patient row ─────────────────────────────────────────

test('conversations.remove() deletes the patient row (name/phone/origin/lang)', async () => {
  const { store, engine } = freshEngine();
  const from = '218970000003';
  // Book so the patient row is populated with PII.
  await send(engine, from, 'نحب نحجز موعد');
  await send(engine, from, 'أمراض القلب');
  await send(engine, from, 'نهار الاثنين الساعة 10 صباحاً');
  await send(engine, from, 'اسمي علي الفيتوري');
  await send(engine, from, 'من طرابلس، ليبيا');
  await send(engine, from, '+218911111111');
  await send(engine, from, 'نعم أكد');

  const A = 'el-amen-sousse';
  assert.ok(await store.patients.get(A, from), 'patient exists before erase');
  const convo = store.getConversation(A, from);
  await store.conversations.remove(A, convo.id);
  assert.equal(await store.patients.get(A, from), null, 'patient PII erased with the conversation');
});
