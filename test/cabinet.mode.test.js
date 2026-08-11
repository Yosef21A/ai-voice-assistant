// D1 — cabinet mode (single-doctor practice). A doctor's bot must never ask
// "which specialty?" (there is one), and it speaks as THE DOCTOR'S assistant by
// name — in the greeting, the handoff, the recap and the confirmation. Both the
// classic state machine and the humanize (LLM-led) path are covered, plus the
// wizard/API persistence of `type` + `doctorName`, plus clinic regressions.
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
import { FakeStructuredProvider } from '../test-helpers/fakeStructuredProvider.js';
import { makeTestApp, listen, request, setupOwner } from '../test-helpers/client.js';

const NOW = new Date(2026, 7, 2, 9, 0, 0); // Sunday 02 Aug 2026, 09:00
const CABINET_PNID = '1000000003'; // cabinet-bensalem-sousse in data/clinics.json

function freshEngine() {
  const base = getConfig();
  const runtimeDir = path.join(os.tmpdir(), `omen-cab-${randomUUID()}`);
  const store = createStore({ clinicsFile: base.clinicsFile, runtimeDir, reset: true });
  const engine = createEngine({ store, provider: new MockProvider(), config: base });
  return { store, engine };
}

function llmEngine(plans) {
  const config = getConfig({ conversationMode: 'llm' });
  const runtimeDir = path.join(os.tmpdir(), `omen-cab-llm-${randomUUID()}`);
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir, reset: true });
  const provider = new FakeStructuredProvider({ plans });
  const engine = createEngine({ store, provider, config });
  return { store, engine, provider };
}

/** Drive a script and return EVERY turn's result (not just the last). */
async function driveAll(engine, { from, phoneNumberId }, script) {
  const outs = [];
  for (const text of script) {
    outs.push(
      await engine.handleMessage(
        { channel: 'simulate', from, text, phoneNumberId, messageId: 'm', timestamp: NOW.getTime() },
        { now: NOW }
      )
    );
  }
  return outs;
}

// The QUESTION phrasings only — the recap legitimately contains the specialty
// as a field label ('الاختصاص: …' / 'Spécialité : …'), which must not match.
const SPECIALTY_QUESTION_MARKERS = [
  'أي اختصاص', 'ما فهمتش الاختصاص',
  'Quelle spécialité', 'pas reconnu la spécialité',
  'Which specialty', "didn't recognize that specialty",
  '1️⃣',
];
const askedSpecialty = (outs) =>
  outs.some((o) => SPECIALTY_QUESTION_MARKERS.some((m) => (o.reply || '').includes(m)));

// ── classic path ─────────────────────────────────────────────────────────────

test('cabinet AR booking end-to-end never asks the specialty question', async () => {
  const { store, engine } = freshEngine();
  const outs = await driveAll(
    engine,
    { from: '21655000010', phoneNumberId: CABINET_PNID },
    [
      'السلام عليكم',
      'نحب نحجز موعد',
      'نهار الثلاثاء الساعة 9 صباحاً',
      'اسمي علي بن عمر',
      'من سوسة',
      '+216 22 123 456',
      'نعم',
    ]
  );

  assert.ok(!askedSpecialty(outs), 'no turn may ask for a specialty');

  // Persona: greeting names the doctor, in Arabic.
  assert.ok(outs[0].reply.includes('مساعد الدكتور بن سالم'), 'greeting speaks as the doctor assistant');
  // Recap (turn 6 is the confirm step) names the doctor.
  assert.ok(outs[5].reply.includes('الطبيب: الدكتور بن سالم'), 'recap names the doctor');
  // Confirmation names the doctor (cabinet closing, not the tourism closing).
  const last = outs[outs.length - 1];
  assert.ok(last.reply.includes('الدكتور بن سالم'), 'confirmation names the doctor');
  assert.ok(!last.reply.includes('الدوليين'), 'no international-patients closing for a cabinet');

  const appts = store.listAppointments();
  assert.equal(appts.length, 1);
  const a = appts[0];
  assert.equal(a.clinicId, 'cabinet-bensalem-sousse');
  assert.equal(a.specialty, 'cardiology', 'booked under the single specialty without asking');
  assert.equal(a.status, 'confirmed');
  // A Sousse local at a Sousse cabinet is NOT a Libyan medical-tourism patient:
  // the tourism default must not leak into local practices (D1 review finding).
  assert.equal(a.originCountry, 'Tunisia');
  const when = new Date(a.datetimeISO);
  assert.equal(when.getDay(), 2, 'lands on a Tuesday');
  assert.ok(isWithinWorkingHours(store.getClinicById(a.clinicId), when));
});

test('cabinet FR booking end-to-end never asks the specialty question', async () => {
  const { store, engine } = freshEngine();
  const outs = await driveAll(
    engine,
    { from: '21655000011', phoneNumberId: CABINET_PNID },
    [
      'Bonjour',
      'Je voudrais prendre un rendez-vous',
      'mardi à 10h',
      "Je m'appelle Karim Haddad",
      'de Sousse',
      '+216 22 555 666',
      'oui je confirme',
    ]
  );

  assert.ok(!askedSpecialty(outs), 'no turn may ask for a specialty');
  assert.ok(outs[0].reply.includes("l'assistant virtuel du Dr Ben Salem"), 'FR greeting names the doctor');
  assert.ok(outs[5].reply.includes('Médecin : Dr Ben Salem'), 'FR recap names the doctor');
  assert.ok(outs[6].reply.includes('Dr Ben Salem'), 'FR confirmation names the doctor');

  const a = store.listAppointments()[0];
  assert.equal(a.clinicId, 'cabinet-bensalem-sousse');
  assert.equal(a.specialty, 'cardiology');
});

test('cabinet handoff line names the doctor', async () => {
  const { engine } = freshEngine();
  const outs = await driveAll(engine, { from: '21655000012', phoneNumberId: CABINET_PNID }, [
    'نحب نتكلم مع موظف',
  ]);
  assert.equal(outs[0].intent, 'human_handoff');
  assert.ok(outs[0].reply.includes('عيادة الدكتور بن سالم'), 'handoff names the doctor practice');
});

// ── generalization: an implied specialty is never asked, for ANY tenant ──────

test('clinic tenant: a message that implies the specialty skips the question', async () => {
  const { engine } = freshEngine();
  const outs = await driveAll(engine, { from: '218910000020', phoneNumberId: '1000000001' }, [
    'نحب نحجز موعد أسنان',
  ]);
  // El Amen (5 specialties): "dental" is implied — the bot must go straight to
  // the datetime question, and never list specialties.
  assert.ok(!askedSpecialty(outs), 'implied specialty is not re-asked');
  assert.equal(outs[0].state?.data?.specialty, 'dental');
  assert.equal(outs[0].state?.step, 'datetime');
});

// ── clinic regression: nothing changes for multi-specialty tenants ───────────

test('clinic greeting/booking unchanged: El Amen still asks the specialty', async () => {
  const { engine } = freshEngine();
  const outs = await driveAll(engine, { from: '218910000021', phoneNumberId: '1000000001' }, [
    'السلام عليكم',
    'نحب نحجز موعد',
  ]);
  assert.ok(!outs[0].reply.includes('الدكتور'), 'clinic greeting has no doctor persona');
  assert.ok(outs[1].reply.includes('اختصاص'), 'multi-specialty clinic still asks');
});

// ── humanize (LLM-led) path ──────────────────────────────────────────────────

test('humanize cabinet: executor seeds the single specialty when the LLM omits it', async () => {
  const plan = (over = {}) => ({
    reply_text: 'باهي 🙌', detected_lang: 'ar', actions: ['none'], slots_patch: {}, ...over,
  });
  const { store, engine, provider } = llmEngine([
    // Turn 1: booking intent with day+name+origin+contact but NO specialty patch.
    plan({
      slots_patch: {
        datetimeText: 'الثلاثاء 9',
        name: 'علي بن عمر',
        origin: 'سوسة',
        contact: '+21622123456',
      },
      actions: ['propose_summary'],
    }),
    // Turn 2: the patient agrees to the recap.
    plan({ actions: ['confirm_booking'], reply_text: 'تم! 🙏' }),
  ]);
  const id = { from: '21655000030', phoneNumberId: CABINET_PNID };
  const first = await driveAll(engine, id, ['نحب موعد الثلاثاء 9، اسمي علي بن عمر من سوسة، رقمي 22123456']);
  assert.equal(first[0].state?.data?.specialty, 'cardiology', 'specialty seeded deterministically');
  assert.ok(first[0].reply.includes('الطبيب: الدكتور بن سالم'), 'humanize recap names the doctor');

  const second = await driveAll(engine, id, ['نعم']);
  const appt = second[0].appointment;
  assert.ok(appt, 'booked');
  assert.equal(appt.specialty, 'cardiology');
  assert.ok(second[0].reply.includes('الدكتور بن سالم'), 'humanize confirmation names the doctor');

  // The system prompt carried both the persona and the never-ask rule.
  const system = provider.calls[0]?.system || '';
  assert.ok(system.includes('FIXED SPECIALTY'), 'prompt carries the never-ask rule');
  assert.ok(system.includes('Ben Salem'), 'prompt carries the doctor persona');

  const a = store.listAppointments()[0];
  assert.equal(a.clinicId, 'cabinet-bensalem-sousse');
});

test('humanize clinic: message-implied specialty is filled, never re-asked (existing behavior)', async () => {
  const plan = {
    reply_text: 'باهي، نهار وقتاش يريحك؟', detected_lang: 'ar',
    actions: ['none'], slots_patch: { specialty: 'dental' },
  };
  const { engine } = llmEngine([plan]);
  const outs = await driveAll(engine, { from: '218910000031', phoneNumberId: '1000000001' }, [
    'نحب نحجز موعد أسنان',
  ]);
  assert.equal(outs[0].state?.data?.specialty, 'dental');
  assert.notEqual(outs[0].state?.step, 'specialty', 'flow advanced past the specialty step');
});

test('humanize clinic prompt has NO fixed-specialty rule for multi-specialty tenants', async () => {
  const plan = { reply_text: 'أهلا!', detected_lang: 'ar', actions: ['none'], slots_patch: {} };
  const { provider, engine } = llmEngine([plan]);
  await driveAll(engine, { from: '218910000032', phoneNumberId: '1000000001' }, ['السلام عليكم']);
  const system = provider.calls[0]?.system || '';
  assert.ok(!system.includes('FIXED SPECIALTY'), 'clinic prompts keep the free specialty flow');
  assert.ok(system.includes('receptionist'), 'clinic persona unchanged');
});

// ── wizard / API persistence ─────────────────────────────────────────────────

test('PUT /api/tenant persists type + doctorName and GET returns them', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const { cookie } = await setupOwner(server, {
      tenantId: 'cabinet-bensalem-sousse',
      email: `own-${randomUUID()}@t.tn`,
    });
    const put = await request(server, 'PUT', '/api/tenant', {
      cookie,
      body: {
        type: 'cabinet',
        doctorName: { fr: 'Trabelsi', ar: 'الطرابلسي' },
        specialties: [{ id: 'cardiology', labels: { fr: 'Cardiologie' } }],
      },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.tenant.config.type, 'cabinet');
    assert.deepEqual(put.body.tenant.config.doctorName, { fr: 'Trabelsi', ar: 'الطرابلسي' });

    const get = await request(server, 'GET', '/api/tenant', { cookie });
    assert.equal(get.status, 200);
    assert.equal(get.body.tenant.config.type, 'cabinet');
    assert.deepEqual(get.body.tenant.config.doctorName, { fr: 'Trabelsi', ar: 'الطرابلسي' });
  } finally {
    server.close();
  }
});

test('PUT /api/tenant refuses to strip a cabinet of its only specialty', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const { cookie } = await setupOwner(server, {
      tenantId: 'cabinet-bensalem-sousse',
      email: `own-${randomUUID()}@t.tn`,
    });
    const put = await request(server, 'PUT', '/api/tenant', {
      cookie,
      body: { specialties: [] }, // type omitted — current config is cabinet
    });
    assert.equal(put.status, 400);
    assert.ok(put.body.details.some((d) => d.includes('specialty')));
  } finally {
    server.close();
  }
});

test('PUT /api/tenant rejects a non-string doctorName label', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const { cookie } = await setupOwner(server, {
      tenantId: 'cabinet-bensalem-sousse',
      email: `own-${randomUUID()}@t.tn`,
    });
    const put = await request(server, 'PUT', '/api/tenant', {
      cookie,
      body: { doctorName: { fr: 123 } },
    });
    assert.equal(put.status, 400);
    assert.ok(put.body.details.some((d) => d.includes('doctorName')));
  } finally {
    server.close();
  }
});

test('PUT /api/tenant rejects an unknown tenant type', async () => {
  const { app } = makeTestApp();
  const server = await listen(app);
  try {
    const { cookie } = await setupOwner(server, {
      tenantId: 'cabinet-bensalem-sousse',
      email: `own-${randomUUID()}@t.tn`,
    });
    const put = await request(server, 'PUT', '/api/tenant', {
      cookie,
      body: { type: 'spa' },
    });
    assert.equal(put.status, 400);
    assert.ok(put.body.details.some((d) => d.includes('type')));
  } finally {
    server.close();
  }
});
