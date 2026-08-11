// V1 voice-note understanding, end-to-end through the REAL ingest pipeline.
//
// Everything here is hermetic: the media client runs on its mock transport and
// the "speech recognition" is a scripted fake. MockProvider has no
// transcribeAudio at all — that ABSENCE is the classic-mode gate, so a test has
// to opt into STT explicitly rather than have words invented for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from '../test-helpers/client.js';
import { FakeStructuredProvider } from '../test-helpers/fakeStructuredProvider.js';
import { ingestInbound } from '../src/api/ingest.js';
import { createTranscriber } from '../src/voice/transcriber.js';
import { gradeTranscript, estimateMaxBytes } from '../src/voice/policy.js';

const A = 'el-amen-sousse';
const EL = JSON.parse(fs.readFileSync(new URL('../data/clinics.json', import.meta.url), 'utf8'))
  .clinics.find((c) => c.id === A);
const PNID = EL.whatsapp.phoneNumberId;

/** A captionless voice note, exactly as the Cloud API delivers it (no duration). */
const voiceNote = (from, mimeType = 'audio/ogg; codecs=opus') => ({
  channel: 'whatsapp',
  from,
  text: '',
  media: { kind: 'audio', id: `MEDIA-${randomUUID()}`, mimeType, caption: '', filename: null },
  phoneNumberId: PNID,
  messageId: `wamid.${randomUUID()}`,
  timestamp: Date.now(),
});

function appWithStt(transcripts, opts = {}) {
  const provider = new FakeStructuredProvider({ transcripts, plans: opts.plans || [] });
  const app = makeTestApp({ ...(opts.config || {}) }, { provider });
  const transcriber = createTranscriber({ provider, config: app.config });
  return { app, provider, transcriber };
}

const deps = ({ app, transcriber }) => ({
  store: app.store,
  engine: app.engine,
  sender: app.sender,
  bus: app.bus,
  mediaClient: app.mediaClient,
  transcriber,
  config: app.config,
});

const lastBotText = async (app, from) => {
  const msgs = await app.store.conversations.listMessages(A, `${A}:${from}`, {});
  const bot = msgs.filter((m) => m.direction === 'outbound' && m.body.by === 'bot');
  return bot.length ? bot[bot.length - 1].body.text : null;
};

// ── the happy path ──────────────────────────────────────────────────────────

test('voice: a transcribed note becomes the turn text and flows through the pipeline', async () => {
  const ctx = appWithStt([
    { transcript: 'نحب نحجز موعد عند طبيب الأسنان', is_speech: true, unclear: false, confidence: 0.92, language: 'ar' },
  ]);
  const from = '218930001001';
  const res = await ingestInbound(deps(ctx), voiceNote(from));

  assert.ok(res.out, 'the engine ran on the transcript — not the 📎 media ack');
  assert.equal(ctx.provider.audioCalls.length, 1, 'the transcriber was called exactly once');
  const reply = await lastBotText(ctx.app, from);
  assert.ok(reply && reply.length > 0, 'the patient got a real reply');
  ctx.app.notifier?.stop?.();
});

test('voice: the transcript is stored on the message and exposed to the inbox', async () => {
  const ctx = appWithStt([
    { transcript: 'عندي وجع في السن', is_speech: true, unclear: false, confidence: 0.9, language: 'ar' },
  ]);
  const from = '218930001002';
  await ingestInbound(deps(ctx), voiceNote(from));

  const msgs = await ctx.app.store.conversations.listMessages(A, `${A}:${from}`, {});
  const inbound = msgs.find((m) => m.direction === 'inbound');
  assert.equal(inbound.body.media.kind, 'audio');
  assert.equal(inbound.body.media.transcript.text, 'عندي وجع في السن');
  assert.equal(inbound.body.media.transcript.grade, 'ok');

  // publicMessage is the single normalization point for the REST thread AND
  // every SSE frame, so proving it there covers both surfaces.
  const { publicMessage } = await import('../src/api/outbound.js');
  const view = publicMessage(inbound);
  assert.equal(view.media.transcript.text, 'عندي وجع في السن');
  assert.equal(view.media.transcript.grade, 'ok');
  ctx.app.notifier?.stop?.();
});

// ── safety ──────────────────────────────────────────────────────────────────

test('voice: an emergency SPOKEN in a voice note triggers the same override as typed', async () => {
  const ctx = appWithStt([
    { transcript: 'صدري يوجعني برشا وما نجمّش نتنفّس', is_speech: true, unclear: false, confidence: 0.95, language: 'ar' },
  ]);
  const from = '218930001003';
  const res = await ingestInbound(deps(ctx), voiceNote(from));

  assert.ok(res.emergency, 'the transcript reached the emergency detector');
  const convo = await ctx.app.store.conversations.getById(A, `${A}:${from}`);
  assert.equal(convo.aiPaused, true, 'the bot stepped back');
  const reply = await lastBotText(ctx.app, from);
  assert.ok(reply.includes('🚨') && reply.includes('190'), 'the safety message went out');
  ctx.app.notifier?.stop?.();
});

// ── honest failure ──────────────────────────────────────────────────────────

test('voice: an unintelligible note gets the warm fallback — never silence, never a guess', async () => {
  const ctx = appWithStt([{ transcript: '', is_speech: false, unclear: true }]);
  const from = '218930001004';
  const res = await ingestInbound(deps(ctx), voiceNote(from));

  assert.equal(res.out, undefined, 'nothing was fed to the engine');
  const reply = await lastBotText(ctx.app, from);
  assert.ok(reply.includes('ما فهمتش'), `expected the warm fallback, got ${JSON.stringify(reply)}`);
  ctx.app.notifier?.stop?.();
});

test('voice: a provider failure degrades to the same warm fallback', async () => {
  const ctx = appWithStt([new Error('gemini http 429')]);
  const from = '218930001005';
  await ingestInbound(deps(ctx), voiceNote(from));
  const reply = await lastBotText(ctx.app, from);
  assert.ok(reply.includes('ما فهمتش'), 'a 429 does not make the bot go quiet');
  ctx.app.notifier?.stop?.();
});

test('voice: a 429 opens the breaker so the next note does not burn more quota', async () => {
  const ctx = appWithStt([new Error('gemini http 429'), { transcript: 'x', is_speech: true, unclear: false }]);
  await ingestInbound(deps(ctx), voiceNote('218930001006'));
  const callsAfterFirst = ctx.provider.audioCalls.length;
  await ingestInbound(deps(ctx), voiceNote('218930001007'));
  assert.equal(
    ctx.provider.audioCalls.length,
    callsAfterFirst,
    'the second voice note short-circuited on the open breaker'
  );
  ctx.app.notifier?.stop?.();
});

// ── classic mode is untouched ───────────────────────────────────────────────

test('voice: with NO transcriber (classic / no key) the behaviour is exactly as before', async () => {
  const app = makeTestApp();
  const from = '218930001008';
  const res = await ingestInbound(
    { store: app.store, engine: app.engine, sender: app.sender, bus: app.bus, mediaClient: app.mediaClient },
    voiceNote(from)
  );
  assert.ok(res.media, 'still handled as media');
  const reply = await lastBotText(app, from);
  assert.ok(reply.includes('📎'), 'the original media acknowledgment is unchanged');
  app.notifier?.stop?.();
});

test('voice: an X-ray is still never interpreted, even with STT available', async () => {
  const ctx = appWithStt([{ transcript: 'should never be used', is_speech: true, unclear: false }]);
  const from = '218930001009';
  const img = {
    ...voiceNote(from),
    media: { kind: 'image', id: 'MEDIA-XRAY', mimeType: 'image/jpeg', caption: '', filename: 'xray.jpg' },
  };
  await ingestInbound(deps(ctx), img);
  assert.equal(ctx.provider.audioCalls.length, 0, 'images are never sent to speech recognition');
  const reply = await lastBotText(ctx.app, from);
  assert.ok(reply.includes('📎'), 'an X-ray still goes to a human, uninterpreted');
  ctx.app.notifier?.stop?.();
});

// ── policy units ────────────────────────────────────────────────────────────

test('policy: the "2 minute" cap is expressed in bytes, per mime', () => {
  // The Cloud API audio object carries no duration, so seconds are unenforceable.
  assert.equal(estimateMaxBytes('audio/ogg; codecs=opus', 120), 360000);
  assert.ok(estimateMaxBytes('audio/mpeg', 120) > estimateMaxBytes('audio/ogg', 120));
});

test('policy: grading is structural, and never invents a confidence', () => {
  assert.equal(gradeTranscript({ transcript: 'نحب نحجز موعد', selfReport: { confidence: 0.9 } }).grade, 'ok');
  assert.equal(gradeTranscript({ transcript: '', selfReport: {} }).grade, 'failed');
  assert.equal(gradeTranscript({ transcript: '...', selfReport: {} }).grade, 'failed');
  assert.equal(gradeTranscript({ transcript: 'anything', selfReport: { is_speech: false } }).grade, 'failed');
  assert.equal(gradeTranscript({ transcript: 'I cannot transcribe this audio', selfReport: {} }).grade, 'failed');
  assert.equal(gradeTranscript({ transcript: 'la la la la la la la la', selfReport: {} }).grade, 'failed');
  // Doubt downgrades to weak rather than failing outright — we still read it back.
  assert.equal(gradeTranscript({ transcript: 'نحب [?] موعد', selfReport: {} }).grade, 'weak');
  assert.equal(
    gradeTranscript({ transcript: 'نحب نحجز', selfReport: { confidence: 0.2 } }).grade,
    'weak'
  );
  // A genuine one-word answer on a short clip is NOT punished as sparse speech.
  assert.equal(
    gradeTranscript({ transcript: 'ايه', selfReport: {}, bytes: 3000, mimeType: 'audio/ogg' }).grade,
    'ok'
  );
});
