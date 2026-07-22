// P2-HUMANIZE §4 — executor safety. The LLM plans; the deterministic executor
// is the only writer: it re-parses datetimes from the patient's words, refuses
// invented prices/diagnosis/promises, honors cancel unconditionally, books only
// with consent + complete slots, and never repeats itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createEngine } from '../src/engine/index.js';
import { MockProvider } from '../src/llm/mockProvider.js';
import { FakeStructuredProvider } from '../test-helpers/fakeStructuredProvider.js';

const NOW = new Date(2026, 7, 2, 9, 0, 0); // Sunday 02 Aug 2026, 09:00
const ID = () => ({ from: `2189${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, phoneNumberId: '1000000001' });

function llmEngine(plans, configOverrides = {}) {
  const config = getConfig({ conversationMode: 'llm', ...configOverrides });
  const runtimeDir = path.join(os.tmpdir(), `omen-hum-${randomUUID()}`);
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir, reset: true });
  const provider = new FakeStructuredProvider({ plans });
  const engine = createEngine({ store, provider, config });
  return { store, engine, provider };
}

async function turn(engine, id, text) {
  return engine.handleMessage(
    { channel: 'simulate', from: id.from, text, phoneNumberId: id.phoneNumberId, messageId: 'm', timestamp: NOW.getTime() },
    { now: NOW }
  );
}

const plan = (over = {}) => ({
  reply_text: 'ok!',
  detected_lang: 'ar',
  actions: ['none'],
  slots_patch: {},
  ...over,
});

// ── datetime: the executor re-parses the patient's words, never LLM values ───

test('executor parses slots_patch.datetimeText itself — "اثنين ١٠" lands Monday 10:00', async () => {
  const { engine } = llmEngine([
    plan({ reply_text: 'باهي، الاثنين على 10 🙌', slots_patch: { datetimeText: 'اثنين ١٠' } }),
  ]);
  const out = await turn(engine, ID(), 'نحب موعد الاثنين ١٠');
  const d = out.state?.data;
  assert.ok(d?.slotIso, 'slot resolved');
  const when = new Date(d.slotIso);
  assert.equal(when.getDay(), 1);
  assert.equal(when.getHours(), 10);
  assert.equal(d.slotAdjusted, false);
});

test('adjusted slot is DISCLOSED: closed-day request adds the ⚠️ note bubble', async () => {
  const { engine } = llmEngine([
    plan({ reply_text: 'تمام، نهار الأحد!', slots_patch: { datetimeText: 'الاحد 10' } }),
  ]);
  const out = await turn(engine, ID(), 'الاحد 10');
  assert.ok(out.replies.some((r) => r.includes('⚠️')), 'adjustment disclosed');
  assert.equal(out.state?.data?.slotAdjusted, true);
});

test('unparseable datetimeText is ignored — no invented slot', async () => {
  const { engine } = llmEngine([
    plan({ reply_text: 'شنية النهار اللي يريحك؟', slots_patch: { datetimeText: 'يمكن قريب' } }),
  ]);
  const out = await turn(engine, ID(), 'يمكن قريب');
  assert.equal(out.state?.data?.slotIso, undefined);
});

// ── guardrails: post-filter on the LLM prose ─────────────────────────────────

test('invented price is stripped and replaced with the safe line', async () => {
  const { engine } = llmEngine([
    plan({ reply_text: 'The full surgery costs exactly 9999€ all included.', detected_lang: 'en' }),
  ]);
  const out = await turn(engine, ID(), 'how much is it');
  assert.ok(!out.reply.includes('9999'), 'invented figure removed');
  assert.ok(out.reply.length > 0, 'never silent');
  assert.ok(out.guardrailViolations?.some((v) => v.startsWith('price')));
});

test('a "from" price that exists in the tenant pricing passes through', async () => {
  const { engine } = llmEngine([
    plan({ reply_text: 'Cardiology consultations start around 40€.', detected_lang: 'en' }),
  ]);
  const out = await turn(engine, ID(), 'price of cardiology?');
  assert.ok(out.reply.includes('40€'), 'legit tenant figure kept');
  assert.equal(out.guardrailViolations, null);
});

test('diagnosis and outcome promises are filtered', async () => {
  const { engine } = llmEngine([
    plan({
      reply_text: 'You probably have a heart disease. Our surgery is 100% guaranteed successful.',
      detected_lang: 'en',
    }),
  ]);
  const out = await turn(engine, ID(), 'my chest hurts sometimes what is it');
  assert.ok(!/you probably have/i.test(out.reply));
  assert.ok(!/100\s*%|guarante/i.test(out.reply));
  assert.ok(out.reply.length > 0);
});

// ── cancel is sacred ─────────────────────────────────────────────────────────

test('cancel_flow always honored — state cleared even when slots arrived too', async () => {
  const { engine, store } = llmEngine([
    plan({ slots_patch: { specialty: 'dental' } }),
    plan({ reply_text: 'ما فيها باس 🙏 وقتاش ما تحب رجعلي.', actions: ['cancel_flow'] }),
  ]);
  const id = ID();
  await turn(engine, id, 'نحب نحجز أسنان');
  const out = await turn(engine, id, 'لا خليها توا');
  assert.equal(out.intent, 'cancel');
  assert.notEqual(out.state?.flow, 'booking');
  assert.equal(store.listAppointments().length, 0);
  assert.ok(out.reply.includes('ما فيها باس'), "the LLM's warm exit is used");
});

// ── booking consent ──────────────────────────────────────────────────────────

const ALL_SLOTS = {
  specialty: 'dental',
  datetimeText: 'الخميس 10',
  name: 'علي الفيتوري',
  origin: 'طرابلس',
  contact: '0912345678',
};

test('confirm_booking without consent downgrades to a template recap', async () => {
  const { engine, store } = llmEngine([
    plan({ reply_text: 'نحجزلك توا!', actions: ['confirm_booking'], slots_patch: ALL_SLOTS }),
  ]);
  const out = await turn(engine, ID(), 'نحب نحجز أسنان الخميس 10 اسمي علي الفيتوري من طرابلس 0912345678');
  assert.equal(store.listAppointments().length, 0, 'no appointment without consent');
  assert.ok(out.replies.some((r) => r.includes('نراجعو الحجز')), 'deterministic recap proposed');
  assert.equal(out.appointment, null);
});

test('confirm_booking with missing slots never creates an appointment', async () => {
  const { engine, store } = llmEngine([
    plan({ actions: ['confirm_booking'], slots_patch: { specialty: 'dental' } }),
  ]);
  const out = await turn(engine, ID(), 'أسنان');
  assert.equal(store.listAppointments().length, 0);
  assert.equal(out.appointment, null);
});

test('recap → "نعم" books deterministically (even when the LLM says none)', async () => {
  const { engine, store } = llmEngine([
    plan({ reply_text: 'هاك التفاصيل:', actions: ['propose_summary'], slots_patch: ALL_SLOTS }),
    plan({ reply_text: 'مبروك!', actions: ['none'] }),
  ]);
  const id = ID();
  const first = await turn(engine, id, 'نحب نحجز أسنان الخميس 10 اسمي علي الفيتوري من طرابلس 0912345678');
  assert.ok(first.replies.some((r) => r.includes('نراجعو الحجز')));
  const out = await turn(engine, id, 'نعم');
  assert.equal(store.listAppointments().length, 1);
  assert.ok(out.appointment);
  assert.match(out.appointment.ref, /^EAS-\d{6}-\d{3}$/);
  assert.ok(out.reply.includes(out.appointment.ref), 'booked recap carries the ref');
  const when = new Date(out.appointment.datetimeISO);
  assert.equal(when.getDay(), 4, 'Thursday');
  assert.equal(when.getHours(), 10);
});

// ── gaps ─────────────────────────────────────────────────────────────────────

test('specialty_gap surfaces a lead payload and keeps the conversation open', async () => {
  const { engine } = llmEngine([
    plan({
      reply_text: 'سؤال مليح — نتأكدلك مع الفريق الطبي ونرجعلك اليوم إن شاء الله 🙏',
      actions: ['specialty_gap'],
      requested_specialty: 'زراعة شعر',
    }),
  ]);
  const out = await turn(engine, ID(), 'عندكم زراعة شعر؟');
  assert.deepEqual(out.gap, { type: 'specialty', requested: 'زراعة شعر', name: null, contact: null });
  assert.ok(!/ما عندناش|choose from|اختار من/.test(out.reply), 'no gate-keeping copy');
});

test('an unmatched slots_patch.specialty also raises the gap', async () => {
  const { engine } = llmEngine([
    plan({ slots_patch: { specialty: 'greffe de cheveux' }, detected_lang: 'fr' }),
  ]);
  const out = await turn(engine, ID(), 'vous faites la greffe de cheveux ?');
  assert.equal(out.gap?.type, 'specialty');
  assert.equal(out.gap?.requested, 'greffe de cheveux');
});

test('kb_gap marks the turn knew:false and passes the cleaned question', async () => {
  const { engine } = llmEngine([
    plan({ actions: ['kb_gap'], kb_question: 'هل تقبلون التأمين الليبي؟' }),
  ]);
  const out = await turn(engine, ID(), 'تقبلو التأمين متاعي الليبي؟');
  assert.equal(out.knew, false);
  assert.equal(out.kbQuestion, 'هل تقبلون التأمين الليبي؟');
});

// ── never-repeat ─────────────────────────────────────────────────────────────

test('a repeated LLM reply triggers ONE regenerate with the vary hint', async () => {
  const same = plan({ reply_text: 'شنوة الاختصاص اللي تحب عليه؟' });
  const { engine, provider } = llmEngine([
    same,
    plan({ reply_text: 'شنوة الاختصاص اللي تحب عليه؟' }), // repeat → regenerate
    plan({ reply_text: 'خلينا ناخذوها بطريقة أخرى: قلّي شنوة مشكلتك ونوجهك 🙌' }),
  ]);
  const id = ID();
  await turn(engine, id, 'موعد');
  const out = await turn(engine, id, 'شنية؟');
  assert.equal(provider.calls.length, 3, 'one initial + one retry on turn 2');
  assert.ok(provider.calls[2].system.includes('DIFFERENT reply'), 'vary hint appended');
  assert.ok(out.reply.includes('بطريقة أخرى'), 'second draft used');
});

test('exhausted regenerate falls back to the variation bank — never a repeat', async () => {
  const { engine } = llmEngine([
    plan({ reply_text: 'اختار من القائمة من فضلك.' }),
    plan({ reply_text: 'اختار من القائمة من فضلك.' }), // repeat, queue then empty
  ]);
  const id = ID();
  const first = await turn(engine, id, 'موعد');
  const out = await turn(engine, id, 'هاه؟');
  assert.notEqual(out.reply, first.reply, 'consecutive identical bot texts impossible');
  assert.ok(out.reply.length > 0);
});

// ── fallback to classic ──────────────────────────────────────────────────────

test('LLM failure → classic flow answers + llm.fallback audit event', async () => {
  const { engine, store } = llmEngine([]); // empty queue: generateStructured throws
  const out = await turn(engine, ID(), 'مرحبا');
  assert.ok(out.reply.includes('أهلاً'), 'classic greeting delivered — bot never silent');
  await new Promise((r) => setImmediate(r));
  const events = await store.events.list('el-amen-sousse', { type: 'llm.fallback' });
  assert.ok(events.length >= 1, 'fallback audited');
});

test('classic mode never calls generateStructured', async () => {
  const config = getConfig({ conversationMode: 'classic' });
  const runtimeDir = path.join(os.tmpdir(), `omen-hum-${randomUUID()}`);
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir, reset: true });
  const provider = new FakeStructuredProvider({ plans: [plan()] });
  const engine = createEngine({ store, provider, config });
  const out = await turn(engine, ID(), 'مرحبا');
  assert.equal(provider.calls.length, 0);
  assert.ok(out.reply.includes('أهلاً'));
});

test('llm mode with a provider lacking generateStructured runs classic', async () => {
  const config = getConfig({ conversationMode: 'llm' });
  const runtimeDir = path.join(os.tmpdir(), `omen-hum-${randomUUID()}`);
  const store = createStore({ clinicsFile: config.clinicsFile, runtimeDir, reset: true });
  const engine = createEngine({ store, provider: new MockProvider(), config });
  const out = await engine.handleMessage(
    { channel: 'simulate', from: '218900000123', text: 'مرحبا', phoneNumberId: '1000000001', messageId: 'm', timestamp: NOW.getTime() },
    { now: NOW }
  );
  assert.ok(out.reply.includes('أهلاً'));
});

// ── language mirroring ───────────────────────────────────────────────────────

test('ar-Latn (Arabizi) maps to Arabic templates and persists on the convo', async () => {
  const { engine, store } = llmEngine([
    plan({ reply_text: 'أهلا وسهلا 👋 كيفاش نجم نعاونك؟', detected_lang: 'ar-Latn' }),
  ]);
  const id = ID();
  const out = await turn(engine, id, 'aslema');
  assert.equal(out.lang, 'ar');
  const convo = store.getConversation('el-amen-sousse', id.from);
  assert.equal(convo.lang, 'ar');
});
