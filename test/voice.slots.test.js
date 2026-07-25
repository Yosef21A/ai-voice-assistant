// Dialect-STT humility guardrail (V1) — "a misheard word must never book an
// appointment", proven rather than asserted in a comment.
//
// Two layers are covered:
//   1. the pure state machine in src/engine/voiceSlots.js;
//   2. the real engine, driven end-to-end through the CLASSIC booking flow with
//      turns flagged `source:'voice'` — classic is the path reached whenever the
//      LLM fails (timeout / 429), which is exactly when a voice turn is most
//      likely to be in flight, so it is the one that must not leak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createEngine } from '../src/engine/index.js';
import { MockProvider } from '../src/llm/mockProvider.js';
import {
  snapshotCritical,
  diffCritical,
  markVoiceProvisional,
  blocksFinalize,
  markEchoed,
  resolveVoiceConfirm,
  clearTypedOverrides,
} from '../src/engine/voiceSlots.js';

const NOW = new Date(2026, 7, 2, 9, 0, 0); // 02 Aug 2026, 09:00

function freshEngine() {
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-voice-${randomUUID()}`);
  const store = createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
  return { store, engine: createEngine({ store, provider: new MockProvider(), config: base }) };
}

/** Drive turns; each entry is a string (typed) or {text, voice:true}. */
async function drive(engine, who, script) {
  let last;
  for (const step of script) {
    const isVoice = typeof step === 'object' && step.voice;
    last = await engine.handleMessage(
      {
        channel: 'simulate',
        from: who.from,
        text: typeof step === 'string' ? step : step.text,
        phoneNumberId: who.phoneNumberId,
        messageId: `m-${randomUUID()}`,
        timestamp: NOW.getTime(),
        ...(isVoice ? { source: 'voice', voice: { grade: step.grade || 'ok' } } : {}),
      },
      { now: NOW }
    );
  }
  return last;
}

// ── the pure state machine ──────────────────────────────────────────────────

test('voiceSlots: a voice turn marks captured slots provisional and blocks finalize', () => {
  const data = {};
  const before = snapshotCritical(data);
  data.specialty = 'dental';
  data.slotIso = '2026-08-06T10:00';
  markVoiceProvisional({ source: 'voice' }, data, before);
  assert.deepEqual(data.voiceProvisional, { specialty: 'heard', slotIso: 'heard' });
  assert.equal(blocksFinalize(data), true, 'unheard-back values block the booking');
});

test('voiceSlots: a TYPED turn marks nothing and never blocks', () => {
  const data = {};
  const before = snapshotCritical(data);
  data.specialty = 'dental';
  markVoiceProvisional({ source: 'text' }, data, before);
  assert.equal(data.voiceProvisional, undefined);
  assert.equal(blocksFinalize(data), false);
});

test('voiceSlots: the read-back (recap) unblocks, then a yes clears the provenance', () => {
  const data = { specialty: 'dental' };
  markVoiceProvisional({ source: 'voice' }, data, snapshotCritical({}));
  assert.equal(blocksFinalize(data), true);
  markEchoed(data); // what buildSummary() does
  assert.equal(blocksFinalize(data), false, 'an echoed value may be booked on consent');
  const r = resolveVoiceConfirm({ source: 'text' }, { h: {} }, data, 'yes');
  assert.equal(r.resolved, 'yes');
  assert.equal(data.voiceProvisional, undefined, 'provenance cleared once confirmed');
});

test('voiceSlots: a "no" DELETES the misheard value instead of merely distrusting it', () => {
  const data = { specialty: 'dental', slotIso: '2026-08-06T10:00', slotAdjusted: false };
  markVoiceProvisional({ source: 'voice' }, data, snapshotCritical({}));
  markEchoed(data);
  const state = { h: { awaitingConfirm: true } };
  const r = resolveVoiceConfirm({ source: 'text' }, state, data, 'no');
  assert.equal(r.resolved, 'no');
  assert.equal(data.specialty, undefined, 'rejected specialty is gone');
  assert.equal(data.slotIso, undefined, 'rejected datetime is gone');
  assert.equal(state.h.awaitingConfirm, false, 'the flow re-asks');
});

test('voiceSlots: a spoken phone number is NEVER written to data.contact', () => {
  const data = {};
  const before = snapshotCritical(data);
  data.contact = '+21629496305';
  markVoiceProvisional({ source: 'voice' }, data, before);
  assert.equal(data.contact, undefined, 'digits heard from speech are not committed');
  assert.equal(data.contactHeard, '+21629496305', 'they are parked for read-back');
  assert.equal(blocksFinalize(data), true);
});

test('voiceSlots: a mis-transcribed "yes" cannot discharge a weak-grade voice turn', () => {
  const data = { specialty: 'dental' };
  markVoiceProvisional({ source: 'voice' }, data, snapshotCritical({}));
  markEchoed(data);
  const weak = resolveVoiceConfirm({ source: 'voice', voice: { grade: 'weak' } }, { h: {} }, data, 'yes');
  assert.equal(weak.resolved, null, 'a doubtful transcript cannot confirm itself');
  assert.ok(data.voiceProvisional, 'still pending');
  const clean = resolveVoiceConfirm({ source: 'voice', voice: { grade: 'ok' } }, { h: {} }, data, 'yes');
  assert.equal(clean.resolved, 'yes', 'a clean voice yes is accepted');
});

test('voiceSlots: typing a value overrides what was heard, for that field only', () => {
  const data = { specialty: 'dental', name: 'Youssef' };
  markVoiceProvisional({ source: 'voice' }, data, snapshotCritical({}));
  clearTypedOverrides({ source: 'text' }, data, ['specialty']);
  assert.equal(data.voiceProvisional.specialty, undefined, 'typed field is trusted');
  assert.equal(data.voiceProvisional.name, 'heard', 'the other field still awaits read-back');
});

test('voiceSlots: a state reset never re-arms the gate', () => {
  const before = snapshotCritical({ specialty: 'dental', slotIso: 'x' });
  assert.deepEqual(diffCritical(before, {}), [], 'clearing values is not a write');
});

// ── the real engine, classic path ───────────────────────────────────────────

test('engine: a "yes" CANNOT book while a voice-derived slot has not been read back', async () => {
  const { store, engine } = freshEngine();
  const who = { from: '218910000771', phoneNumberId: '1000000001' };
  // Drive a normal booking to the confirm step.
  await drive(engine, who, [
    'نحب نحجز موعد',
    'أمراض القلب',
    'نهار الخميس على العاشرة',
    'يوسف عبدالهادي',
    'من طرابلس ليبيا',
    '+218920000771',
  ]);

  // Simulate the dangerous state: a slot captured from speech that the bot has
  // NOT read back (e.g. the recap never rendered because the LLM turn failed
  // mid-flight and the classic path resumed at 'confirm').
  // Resolve the tenant exactly as the engine does (this phone_number_id is not
  // in the registry — el-amen was re-keyed to the live Meta id — so the engine
  // falls back to the default clinic, and the test must follow it there).
  const clinic =
    store.getClinicByPhoneNumberId(who.phoneNumberId) || store.getDefaultClinic();
  const convo = store.getConversation(clinic.id, who.from);
  convo.state.data.voiceProvisional = { slotIso: 'heard' };
  store.saveConversation(convo);
  const beforeCount = store.listAppointments({ clinicId: clinic.id }).length;

  const res = await drive(engine, who, ['نعم']);

  assert.ok(!res.appointment, 'the misheard slot did NOT book an appointment');
  assert.equal(
    store.listAppointments({ clinicId: clinic.id }).length,
    beforeCount,
    'no appointment was written to the store'
  );
  // …and the bot is not stuck: it re-renders the recap, which IS the read-back,
  // so the very next "نعم" completes the booking.
  const after = store.getConversation(clinic.id, who.from);
  assert.equal(after.state.data.voiceProvisional.slotIso, 'echoed', 'the recap discharged it');

  const second = await drive(engine, who, ['نعم']);
  assert.ok(second.appointment, 'one read-back later, the booking completes');
});

test('engine: a TYPED booking is completely unaffected by the guardrail (regression)', async () => {
  const { store, engine } = freshEngine();
  const who = { from: '218910000772', phoneNumberId: '1000000001' };
  const last = await drive(engine, who, [
    'نحب نحجز موعد',
    'أمراض القلب',
    'نهار الخميس على العاشرة',
    'يوسف عبدالهادي',
    'من طرابلس ليبيا',
    '+218920000772',
    'نعم',
  ]);
  assert.ok(last.appointment, 'typed bookings still complete in the same number of turns');
  assert.equal(last.appointment.patientName, 'يوسف عبدالهادي');
});
