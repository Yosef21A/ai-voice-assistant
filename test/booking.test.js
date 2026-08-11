import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createEngine } from '../src/engine/index.js';
import { MockProvider } from '../src/llm/mockProvider.js';
import { isWithinWorkingHours } from '../src/store/availability.js';

const NOW = new Date(2026, 7, 2, 9, 0, 0); // fixed reference: 02 Aug 2026, 09:00

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

test('full Arabic booking flow creates a valid appointment', async () => {
  const { store, engine } = freshEngine();
  const last = await drive(
    engine,
    { from: '218910000001', phoneNumberId: '1000000001' },
    [
      'السلام عليكم',
      'نحب نحجز موعد',
      'أمراض القلب',
      'نهار الاثنين الساعة 10 صباحاً',
      'اسمي محمد العبيدي',
      'من طرابلس، ليبيا',
      '+218 91 000 0001',
      'نعم أكد',
    ]
  );

  assert.ok(last.appointment, 'an appointment should be returned');
  const appts = store.listAppointments();
  assert.equal(appts.length, 1);

  const a = appts[0];
  assert.equal(a.clinicId, 'el-amen-sousse');
  assert.equal(a.specialty, 'cardiology');
  assert.equal(a.patientName, 'محمد العبيدي');
  assert.equal(a.originCity, 'Tripoli');
  assert.equal(a.originCountry, 'Libya');
  assert.equal(a.contact, '+218910000001');
  assert.equal(a.lang, 'ar');
  assert.equal(a.status, 'confirmed');
  assert.match(a.ref, /^EAS-\d{6}-\d{3}$/);

  const when = new Date(a.datetimeISO);
  assert.ok(!Number.isNaN(when.getTime()), 'datetime parses');
  assert.equal(when.getDay(), 1, 'lands on a Monday');
  assert.ok(isWithinWorkingHours(store.getClinicById(a.clinicId), when), 'inside working hours');
});

test('full French booking flow at the second tenant', async () => {
  const { store, engine } = freshEngine();
  const last = await drive(
    engine,
    { from: '218920000002', phoneNumberId: '1000000002' },
    [
      'Bonjour',
      'Je voudrais prendre un rendez-vous',
      'Chirurgie esthétique',
      'vendredi à 11h',
      "Je m'appelle Amina Ben Salah",
      'je viens de Benghazi, Libye',
      'mon numéro est +218 92 000 0002',
      'oui je confirme',
    ]
  );

  assert.ok(last.appointment);
  const a = store.listAppointments()[0];
  assert.equal(a.clinicId, 'ennour-sfax'); // routed by phone_number_id -> multi-tenant
  assert.equal(a.specialty, 'cosmetic_surgery');
  assert.equal(a.patientName, 'Amina Ben Salah');
  assert.equal(a.originCity, 'Benghazi');
  assert.equal(a.contact, '+218920000002');
  assert.equal(a.lang, 'fr');
  assert.equal(a.status, 'confirmed');

  const when = new Date(a.datetimeISO);
  assert.equal(when.getDay(), 5, 'lands on a Friday');
  assert.ok(isWithinWorkingHours(store.getClinicById(a.clinicId), when));
});

test('state persists across turns and no appointment before confirmation', async () => {
  const { store, engine } = freshEngine();
  const id = { from: '218911111111', phoneNumberId: '1000000001' };

  let r = await drive(engine, id, ['نحب نحجز موعد']);
  assert.equal(r.state?.flow, 'booking');
  assert.equal(store.listAppointments().length, 0);

  r = await drive(engine, id, ['أمراض الأسنان']); // dental
  assert.equal(r.state?.step, 'datetime');
  assert.equal(store.listAppointments().length, 0, 'still no appointment mid-flow');
});

test('cancel during booking aborts without creating an appointment', async () => {
  const { store, engine } = freshEngine();
  const id = { from: '218922222222', phoneNumberId: '1000000001' };
  await drive(engine, id, ['نحب نحجز موعد', 'أمراض القلب', 'إلغاء']);
  assert.equal(store.listAppointments().length, 0);
  const convo = store.getConversation('el-amen-sousse', '218922222222');
  assert.equal(convo.state, null, 'flow cleared after cancel');
});

test('an out-of-hours request is auto-adjusted to a valid slot', async () => {
  const { store, engine } = freshEngine();
  const id = { from: '218933333333', phoneNumberId: '1000000001' };
  // El Amen is closed Sunday and Fri afternoon; ask for Sunday 20:00.
  await drive(engine, id, [
    'book appointment',
    'cardiology',
    'Sunday at 20:00',
    'John Doe',
    'from Misrata, Libya',
    '+218900000000',
    'yes',
  ]);
  const a = store.listAppointments()[0];
  assert.ok(a, 'appointment created despite impossible request');
  const when = new Date(a.datetimeISO);
  assert.ok(isWithinWorkingHours(store.getClinicById(a.clinicId), when), 'snapped into working hours');
  assert.equal(a.datetimeAdjusted, true);
});
