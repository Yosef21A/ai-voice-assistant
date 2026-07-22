// P2-HUMANIZE §4 — replay goldens for the REAL conversation failures F1–F7
// (data/runtime log of el-amen-sousse:21629496305), asserted end-to-end through
// the LLM-led engine + executor with a scripted FakeStructuredProvider; the
// ingest-level cases (F6 handoff, specialty_gap lead, admin.notify, mark-as-
// read) run through ingestInbound + the notification worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createEngine } from '../src/engine/index.js';
import { FakeStructuredProvider } from '../test-helpers/fakeStructuredProvider.js';
import { makeTestApp } from '../test-helpers/client.js';
import { ingestInbound } from '../src/api/ingest.js';

const NOW = new Date(2026, 7, 2, 9, 0, 0);
const A = 'el-amen-sousse';
const EL = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A);
const PNID = EL.whatsapp.phoneNumberId;
const OWNER = String(EL.notifications?.recipients?.[0] || EL.handoff.phone).replace(/\D/g, '');

function llmEngine(plans) {
  const config = getConfig({ conversationMode: 'llm' });
  const runtimeDir = path.join(os.tmpdir(), `omen-replay-${randomUUID()}`);
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir, reset: true });
  const provider = new FakeStructuredProvider({ plans });
  const engine = createEngine({ store, provider, config });
  return { store, engine, provider };
}

async function turn(engine, from, text) {
  return engine.handleMessage(
    { channel: 'simulate', from, text, phoneNumberId: '1000000001', messageId: 'm', timestamp: NOW.getTime() },
    { now: NOW }
  );
}

const plan = (over = {}) => ({
  reply_text: 'ok',
  detected_lang: 'ar',
  actions: ['none'],
  slots_patch: {},
  ...over,
});

function readOutbox(app) {
  const f = path.join(app.runtimeDir, 'outbox.json');
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) || [];
  } catch {
    return [];
  }
}

async function feed(app, from, text) {
  const r = await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    { channel: 'whatsapp', from, text, phoneNumberId: PNID, messageId: `wamid.${randomUUID()}`, timestamp: Date.now() }
  );
  await app.notifier.settled();
  return r;
}

// ── F1: explicit refusal must never loop a specialty menu ────────────────────
test('F1: "I dont wanna book" → warm exit, no specialty-menu loop', async () => {
  const { engine, store } = llmEngine([
    plan({ reply_text: 'Sure! Which specialty would you like?', detected_lang: 'en', slots_patch: {} }),
    plan({
      reply_text: "No problem at all 🙏 Come back whenever you like. Want me to leave your number with the team?",
      detected_lang: 'en',
      actions: ['cancel_flow'],
    }),
  ]);
  const from = '218911100001';
  await turn(engine, from, 'I want to book');
  const out = await turn(engine, from, 'I dont wanna book');
  assert.equal(out.intent, 'cancel');
  assert.ok(!/didn't recognize that specialty/i.test(out.reply));
  assert.ok(out.reply.includes('No problem'));
  assert.equal(store.listAppointments().length, 0);
});

test('F1 safety net: refusal reaches classic mode too (intent keywords)', async () => {
  const config = getConfig({ conversationMode: 'classic' });
  const runtimeDir = path.join(os.tmpdir(), `omen-replay-${randomUUID()}`);
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir, reset: true });
  const engine = createEngine({ store, provider: new FakeStructuredProvider({}), config });
  const from = '218911100002';
  await turn(engine, from, 'book appointment');
  const out = await turn(engine, from, 'I dont wanna book');
  assert.equal(out.intent, 'cancel', 'refusal beats the specialty step');
  const convo = store.getConversation(A, from);
  assert.equal(convo.state, null, 'flow released');
});

// ── F2: Arabizi + phone-style hellos get greeted, not "didn't understand" ────
test('F2: "aslema" → Arabic greeting via ar-Latn mirroring', async () => {
  const { engine } = llmEngine([
    plan({ reply_text: 'أهلا وسهلا 👋 كيفاش نجم نعاونك اليوم؟', detected_lang: 'ar-Latn' }),
  ]);
  const out = await turn(engine, '218911100003', 'aslema');
  assert.equal(out.lang, 'ar');
  assert.ok(/أهلا/.test(out.reply), 'reply in Arabic script');
});

// ── F3: restated intent mid-flow is understood, not treated as a bad answer ──
test('F3: "مرحبا نحب نحجز موعد" mid-specialty is met fresh, no specialtyUnknown', async () => {
  const { engine } = llmEngine([
    plan({ reply_text: 'يا مرحبا 👋 شنوة نوع العلاج اللي يهمك؟' }),
    plan({ reply_text: 'أهلا بيك من جديد 🙌 قلّي شنوة الاختصاص اللي تحب عليه — أسنان، قلب، تجميل…' }),
  ]);
  const from = '218911100004';
  await turn(engine, from, 'نحب نحجز موعد');
  const out = await turn(engine, from, 'مرحبا نحب نحجز موعد');
  assert.ok(!out.reply.includes('ما فهمتش الاختصاص'), 'no state tunnel vision');
  assert.equal(out.intent, 'book_appointment');
});

// ── F5: "Alo" during confirm → gentle nudge, no recap re-paste ───────────────
test('F5: interjection at the recap gets a light answer, then نعم books', async () => {
  const ALL = {
    specialty: 'cardiology',
    datetimeText: 'الاثنين 10',
    name: 'بعبوص خشين',
    origin: 'طرابلس',
    contact: '29496305',
  };
  const { engine, store } = llmEngine([
    plan({ reply_text: 'هاك ملخص الحجز 👇', actions: ['propose_summary'], slots_patch: ALL }),
    plan({ reply_text: 'أهلا 👋 نعم؟ نأكدو الموعد ولا تحب تبدل حاجة؟' }),
    plan({ reply_text: 'تمام!' }),
  ]);
  const from = '218911100005';
  const recap = await turn(engine, from, 'نحب نحجز قلب الاثنين 10 اسمي بعبوص خشين من طرابلس 29496305');
  assert.ok(recap.replies.some((r) => r.includes('نراجعو الحجز')));

  const alo = await turn(engine, from, 'Alo');
  assert.ok(!alo.reply.includes('نراجعو الحجز'), 'recap NOT re-pasted');
  assert.ok(!alo.reply.includes('جاوبني بـ'), 'no drill-sergeant tone');

  const yes = await turn(engine, from, 'نعم');
  assert.ok(yes.appointment, 'booking still lands after the digression');
  const when = new Date(yes.appointment.datetimeISO);
  assert.equal(when.getHours(), 10, 'F4 fix holds inside the llm flow');
  assert.equal(store.listAppointments().length, 1);
});

// ── F7: post-booking memory — an extra نعم is closure, not a menu ────────────
test('F7: extra "نعم" after confirmation gets a warm micro-reply', async () => {
  const ALL = {
    specialty: 'dental',
    datetimeText: 'الخميس 10',
    name: 'علي الفيتوري',
    origin: 'بنغازي',
    contact: '0912345678',
  };
  const { engine } = llmEngine([
    plan({ reply_text: 'هاك التفاصيل 👇', actions: ['propose_summary'], slots_patch: ALL }),
    plan({ reply_text: 'مبروك 🌿', actions: ['confirm_booking'] }),
    plan({ reply_text: 'بالخدمة ديما 🌿 لو تحب حاجة أخرى راني هنا.' }),
  ]);
  const from = '218911100006';
  await turn(engine, from, 'نحجز أسنان الخميس 10 اسمي علي الفيتوري من بنغازي 0912345678');
  const booked = await turn(engine, from, 'نعم');
  assert.ok(booked.appointment);

  const extra = await turn(engine, from, 'نعم');
  assert.ok(!extra.reply.includes('ما فهمتش قصدك'), 'no generic menu');
  assert.ok(extra.reply.includes('بالخدمة'), 'warm micro-reply');
  assert.equal(extra.appointment, null, 'no double booking');
  assert.equal(extra.state?.h?.lastBooking?.ref?.startsWith('EAS-'), true, 'booking memory kept');
});

// ── F9: stale classic flow releases its lock but keeps slots ─────────────────
test('F9: a booking flow idle >2h no longer imprisons the next message', async () => {
  const config = getConfig({ conversationMode: 'classic' });
  const runtimeDir = path.join(os.tmpdir(), `omen-replay-${randomUUID()}`);
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir, reset: true });
  const engine = createEngine({ store, provider: new FakeStructuredProvider({}), config });
  const from = '218911100007';
  await turn(engine, from, 'نحب نحجز موعد');
  await turn(engine, from, 'أسنان'); // specialty locked in

  // Three days later the patient greets — the old step must not eat it.
  const LATER = new Date(2026, 7, 5, 9, 0, 0);
  const out = await engine.handleMessage(
    { channel: 'simulate', from, text: 'aslema', phoneNumberId: '1000000001', messageId: 'm', timestamp: LATER.getTime() },
    { now: LATER }
  );
  assert.ok(!out.reply.includes('ما فهمتش الوقت'), 'not treated as a datetime answer');
  assert.ok(out.reply.includes('أهلاً'), 'greeted fresh');
  // And the collected specialty survives a booking restart:
  const again = await engine.handleMessage(
    { channel: 'simulate', from, text: 'نحب نحجز موعد', phoneNumberId: '1000000001', messageId: 'm', timestamp: LATER.getTime() },
    { now: LATER }
  );
  assert.equal(again.state?.data?.specialty, 'dental', 'slots kept across the decay');
});

// ── ingest-level e2e (F6 handoff, gap→lead, admin.notify, mark-as-read) ──────

test('F6: handoff keeps the patient in the chat — pause + 🙋 owner alert', async (t) => {
  const fake = new FakeStructuredProvider({
    plans: [
      plan({
        reply_text: 'طلبتلك واحد من الفريق توّا 👌 يجاوبك هنا في نفس المحادثة.',
        actions: ['handoff_request'],
      }),
    ],
  });
  const app = makeTestApp({ conversationMode: 'llm' }, { provider: fake });
  t.after(() => app.notifier.stop());
  await app.kbReady;

  const r = await feed(app, '218922200001', 'موظف');
  assert.ok(r.out.handoff, 'handoff surfaced');
  assert.ok(r.out.reply.includes('نفس المحادثة'), 'patient told the team replies HERE');

  const convo = await app.store.conversations.get(A, '218922200001');
  assert.equal(convo.aiPaused, true, 'bot stepped back');
  assert.equal(convo.status, 'needs_human');

  const alerts = readOutbox(app).filter((x) => x.ok && x.to === OWNER).map((x) => x.payload.text.body);
  assert.ok(alerts.some((a) => a.includes('🙋')), 'owner handoff alert sent');
});

test('specialty_gap → lead persisted + 🔥 owner alert, conversation stays open', async (t) => {
  const fake = new FakeStructuredProvider({
    plans: [
      plan({
        reply_text: 'سؤال مليح — نتأكدلك مع الفريق الطبي ونرجعلك اليوم إن شاء الله 🙏 في الأثناء، تنجم تعطيني اسمك ورقمك؟',
        actions: ['specialty_gap'],
        requested_specialty: 'زراعة الشعر',
      }),
    ],
  });
  const app = makeTestApp({ conversationMode: 'llm' }, { provider: fake });
  t.after(() => app.notifier.stop());
  await app.kbReady;

  await feed(app, '218922200002', 'عندكم زراعة شعر؟');

  const leads = await app.store.leads.list(A);
  const lead = leads.find((l) => l.details?.reason === 'specialty_gap');
  assert.ok(lead, 'gap captured as a lead');
  assert.equal(lead.procedure, 'زراعة الشعر');
  assert.equal(lead.patientWaId, '218922200002');

  const alerts = readOutbox(app).filter((x) => x.ok && x.to === OWNER).map((x) => x.payload.text.body);
  assert.ok(alerts.some((a) => a.includes('🔥')), 'owner hot-lead alert sent');

  const convo = await app.store.conversations.get(A, '218922200002');
  assert.equal(convo.aiPaused, false, 'bot keeps chatting — never let the client go');
});

test('notify_admin → 👀 owner alert without pausing the bot', async (t) => {
  const fake = new FakeStructuredProvider({
    plans: [
      plan({
        reply_text: 'نصيحة: كلم العيادة مباشرة على الرقم، أما نجم نعاونك هنا زادة.',
        actions: ['notify_admin'],
        action_reason: 'Patient sounds distressed about a scheduled surgery',
      }),
    ],
  });
  const app = makeTestApp({ conversationMode: 'llm' }, { provider: fake });
  t.after(() => app.notifier.stop());
  await app.kbReady;

  await feed(app, '218922200003', 'راني قلقان برشا على العملية متاعي');

  const alerts = readOutbox(app).filter((x) => x.ok && x.to === OWNER).map((x) => x.payload.text.body);
  assert.ok(alerts.some((a) => a.includes('👀')), 'admin.notify owner alert sent');

  const convo = await app.store.conversations.get(A, '218922200003');
  assert.equal(convo.aiPaused, false, 'bot NOT paused');
});

test('mark-as-read + typing fires on every whatsapp inbound (mock outbox record)', async (t) => {
  const fake = new FakeStructuredProvider({ plans: [plan({ reply_text: 'أهلا 👋' })] });
  const app = makeTestApp({ conversationMode: 'llm' }, { provider: fake });
  t.after(() => app.notifier.stop());
  await app.kbReady;

  await feed(app, '218922200004', 'مرحبا');
  const reads = readOutbox(app).filter((x) => x.kind === 'read');
  assert.ok(reads.length >= 1, 'read receipt recorded');
  assert.deepEqual(reads[0].payload.typing_indicator, { type: 'text' }, 'typing indicator piggybacked');
});

test('sandbox test-drives never leak specialty_gap leads', async (t) => {
  const fake = new FakeStructuredProvider({
    plans: [plan({ actions: ['specialty_gap'], requested_specialty: 'lasik' })],
  });
  const app = makeTestApp({ conversationMode: 'llm' }, { provider: fake });
  t.after(() => app.notifier.stop());
  await app.kbReady;

  await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    { channel: 'whatsapp', from: 'sandbox:u1', text: 'lasik?', phoneNumberId: PNID, messageId: 'wamid.sbx', timestamp: Date.now() }
  );
  await app.notifier.settled();
  const leads = await app.store.leads.list(A);
  assert.equal(leads.length, 0, 'sandbox excluded from the pipeline');
});
