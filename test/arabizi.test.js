// P2-HUMANIZE §4 — Arabizi detection + intent coverage (F2) and the classic
// sender-delay seam. "aslema", "na7eb na7jez", "chhal" must ride the AR paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, isArabizi } from '../src/engine/language.js';
import { detectIntent } from '../src/engine/intent.js';
import { splitBubbles } from '../src/engine/text.js';
import { WhatsAppSender } from '../src/whatsapp/index.js';

// ── detection ────────────────────────────────────────────────────────────────

test('Arabizi greetings and phrases detect as Arabic', () => {
  assert.equal(detectLanguage('aslema'), 'ar');
  assert.equal(detectLanguage('na7eb na7jez'), 'ar');
  assert.equal(detectLanguage('chhal el prix'), 'ar');
  assert.equal(detectLanguage('3aslema labes?'), 'ar');
});

test('plain English/French with digits is NOT Arabizi', () => {
  assert.equal(isArabizi('see you at 3pm'), false);
  assert.equal(isArabizi('rendez-vous a 10h30'), false);
  assert.equal(isArabizi('hello how are you'), false);
  assert.equal(detectLanguage('hello how are you'), 'en');
});

test('real Arabic script wins over the Arabizi check', () => {
  assert.equal(isArabizi('مرحبا'), false);
  assert.equal(detectLanguage('مرحبا'), 'ar');
});

// ── intent keywords (F1/F2/F5 dead ends) ─────────────────────────────────────

test('Arabizi booking/pricing phrases route to the right intents', () => {
  assert.equal(detectIntent('na7jez maw3ed').intent, 'book_appointment');
  assert.equal(detectIntent('7ajz').intent, 'book_appointment');
  assert.equal(detectIntent('chhal').intent, 'pricing_quote');
  assert.equal(detectIntent('9adech el prix').intent, 'pricing_quote');
  assert.equal(detectIntent('aslema').intent, 'greeting');
});

test('phone-style hellos are greetings, not unknowns', () => {
  assert.equal(detectIntent('الو').intent, 'greeting');
  assert.equal(detectIntent('هالو').intent, 'greeting');
  assert.equal(detectIntent('Alo').intent, 'greeting');
  assert.equal(detectIntent('allo').intent, 'greeting');
});

test('word-boundary safety: "alo" never fires inside other words', () => {
  assert.notEqual(detectIntent('I am alone here').intent, 'greeting');
  assert.notEqual(detectIntent('بالوقت الحالي').intent, 'greeting');
});

test('refusals are cancel, not noise (F1)', () => {
  assert.equal(detectIntent('I dont wanna book').intent, 'cancel');
  assert.equal(detectIntent("i don't want this").intent, 'cancel');
  assert.equal(detectIntent('not now thanks').intent, 'cancel');
  assert.equal(detectIntent('مانحبش').intent, 'cancel');
});

// ── bubble splitting ─────────────────────────────────────────────────────────

test('splitBubbles: long prose splits into two, recaps stay whole', () => {
  const prose = 'First sentence here. Second one follows. A third one too. And a fourth closes it.';
  const parts = splitBubbles(prose, 2);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].length > 0 && parts[1].length > 0);

  const recap = '📝 نراجعو الحجز:\n• الاختصاص: قلب\n• الموعد: الاثنين 10:00';
  assert.deepEqual(splitBubbles(recap, 2), [recap], 'bullet recaps never split');

  assert.deepEqual(splitBubbles('Short one. Done.', 2), ['Short one. Done.'], '≤2 sentences stay one bubble');
});

// ── humanized delay seam (P2-HUMANIZE §3) ────────────────────────────────────

test('sendEngineReply paces bubbles via the injected sleep when enabled', async () => {
  const sleeps = [];
  const sender = new WhatsAppSender({
    transport: 'mock',
    humanizeDelays: true,
    outboxFile: `${process.env.TEMP || '/tmp'}/omen-delay-${Date.now()}.json`,
    sleep: async (ms) => sleeps.push(ms),
  });
  const text1 = 'أهلا بيك 👋';
  const text2 = 'كيفاش نجم نعاونك اليوم؟';
  await sender.sendEngineReply({ id: 't', whatsapp: { phoneNumberId: '1' } }, '21600000000', {
    replies: [text1, text2],
  });
  assert.equal(sleeps.length, 2, 'one pause per bubble');
  const expect = (s) => Math.min(1.2 + s.length / 60, 4) * 1000;
  assert.ok(Math.abs(sleeps[0] - expect(text1)) < 1);
  assert.ok(Math.abs(sleeps[1] - expect(text2)) < 1);
});

test('delays are OFF by default on the mock transport (tests stay fast)', async () => {
  const sleeps = [];
  const sender = new WhatsAppSender({
    transport: 'mock',
    outboxFile: `${process.env.TEMP || '/tmp'}/omen-delay2-${Date.now()}.json`,
    sleep: async (ms) => sleeps.push(ms),
  });
  await sender.sendEngineReply({ id: 't', whatsapp: { phoneNumberId: '1' } }, '21600000000', {
    replies: ['a', 'b'],
  });
  assert.equal(sleeps.length, 0);
});
