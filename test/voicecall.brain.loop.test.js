// The per-call brain loop (V2) — golden flows against the REAL store, bus and
// mock sender, with exactly one seam faked: the Gemini Live client.
//
// Faking the live client is the whole point. It lets a test drive the model's
// side of a conversation deterministically — "the caller said this", "the model
// called that tool" — and then assert on the things that must be true no matter
// what the model does: what got written, what the owner was told, and what the
// agent was FORCED to say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers/client.js';
import { createBrainLoop } from '../src/voice-call/brain/loop.js';
import { clearGreetingCache } from '../src/voice-call/brain/greetingCache.js';
import { buildEmergencyReply, buildSpokenEmergencyReply } from '../src/notifications/pipeline.js';
import { t as tr } from '../src/engine/responses.js';
import { nowString } from '../src/engine/humanize/context.js';

const CLINIC = 'el-amen-sousse';
const WA = '218911234567';
const NOW = () => new Date(2026, 7, 5, 10, 0, 0); // Wednesday, clinic open

const OPUS_SDP =
  'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 101\r\n' +
  'a=rtpmap:111 opus/48000/2\r\na=rtpmap:101 telephone-event/8000\r\n';

/** A fake Gemini Live client: records our side, lets the test drive theirs. */
function fakeLive() {
  const handlers = new Map();
  const api = {
    opts: null,
    sentText: [],
    toolResponses: [],
    audioChunks: [],
    closed: 0,
    on(ev, cb) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(cb);
      return () => {};
    },
    emit(ev, payload) {
      for (const cb of handlers.get(ev) || []) cb(payload);
    },
    sendAudioChunk(pcm) {
      api.audioChunks.push(pcm);
    },
    sendText(text) {
      api.sentText.push(text);
      return true;
    },
    sendToolResponse(r) {
      api.toolResponses.push(r);
      return true;
    },
    close() {
      api.closed += 1;
    },
    stats: () => ({ fake: true }),
  };
  api.ready = new Promise((res, rej) => {
    api.setupComplete = () => res(true);
    api.failSetup = (e) => rej(e instanceof Error ? e : new Error(String(e)));
  });
  api.ready.catch(() => {});
  return api;
}

function fakeMedia({ sdpAnswer = OPUS_SDP } = {}) {
  const sent = [];
  return {
    sdpAnswer,
    sent,
    sendRtp(p) {
      sent.push(p);
      return true;
    },
    close() {},
  };
}

/** Compose a loop over the app's real store/bus/sender. */
async function setup({ tenantId = CLINIC, config = {}, autoReady = true, ended = [] } = {}) {
  // The greeting cache is process-global by design (V5-T0). Every test in this
  // file asserts on the LIVE greeting path, so the tape starts empty — without
  // this, one test that records a greeting silently changes the next one.
  clearGreetingCache();
  const app = makeTestApp();
  const clinic = app.store.getClinicById(tenantId);
  const convo = await app.store.conversations.create(tenantId, { patientWaId: WA, status: 'open' });
  const events = [];
  const unsub = app.bus.subscribe((e) => events.push(e));
  const live = fakeLive();
  const media = fakeMedia();

  const loop = createBrainLoop({
    clinic,
    convo,
    media,
    store: app.store,
    bus: app.bus,
    sender: app.sender,
    config: { geminiApiKey: '', geminiLiveModel: 'test-live', ...config },
    lang: 'ar',
    patientWaId: WA,
    sdpOffer: OPUS_SDP,
    now: NOW,
    logger: () => {},
    liveFactory: (opts) => {
      live.opts = opts;
      if (autoReady) live.setupComplete();
      return live;
    },
    onEnd: (o) => ended.push(o),
  });
  return { app, clinic, convo, events, unsub, live, media, loop, ended, tenantId };
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const call = (name, args = {}, id = name) => [{ id, name, args }];
/** ms of 440 Hz at the brain's 24 kHz output rate. */
function tone24k(ms) {
  const n = Math.round((24000 * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. the golden path ──────────────────────────────────────────────────────

test('AR booking end to end: greet → stage → recap → confirm → appointment exists', async (t) => {
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });

  await s.loop.start();

  // The agent speaks FIRST — a silent line after "allo?" reads as broken.
  assert.equal(s.live.sentText.length, 1);
  assert.match(s.live.sentText[0], /Greet them now in Arabic/);
  assert.ok(s.live.sentText[0].includes(s.clinic.name));
  assert.match(s.live.sentText[0], /automated assistant/, 'the AI disclosure is instructed up front');

  // The session was opened with the right persona and the right capabilities.
  assert.equal(s.live.opts.model, 'test-live');
  assert.deepEqual(
    s.live.opts.tools.map((d) => d.name),
    ['get_available_slots', 'stage_booking', 'confirm_booking', 'request_handoff']
  );
  const sys = s.live.opts.systemInstruction;
  assert.ok(sys.includes('NEVER diagnose'), 'the guardrail preamble is present');
  assert.ok(sys.includes(s.clinic.name));
  assert.ok(/final amount is set after the doctor|final amount ONLY after medical assessment/.test(sys));
  // Same "what time is it" string the chat engine grounds on — imported, not
  // re-implemented, so the two channels cannot disagree about today's date.
  assert.ok(sys.includes(nowString(NOW())), 'the clock is shared with the chat prompt');
  // Noisy Libyan lines: the keypad is offered rather than a third "sorry?".
  assert.ok(/press 1 to book, 2 to reach the team/.test(sys), 'the DTMF fallback is offered');

  // ── the conversation ──
  s.live.emit('inputTranscription', 'نحب نحجز موعد قلب');
  s.live.emit('outputTranscription', 'أهلا وسهلا، ');

  s.live.emit(
    'toolCall',
    call('stage_booking', {
      specialty: 'قلب',
      datetimeText: 'الخميس 10',
      name: 'محمد الهادي',
      contact: '21650123456',
    })
  );
  await s.loop.settled();

  const staged = s.live.toolResponses[0][0];
  assert.equal(staged.name, 'stage_booking');
  assert.equal(staged.response.result.ok, true);
  const recap = staged.response.result.recap;
  assert.ok(recap.includes('محمد الهادي') && recap.includes('21650123456'));
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0, 'still nothing written');

  // The recap is SPOKEN, not printed — no dd/mm/yyyy ever reaches a mouth.
  assert.ok(!/\d{2}\/\d{2}\/\d{4}/.test(recap), recap);
  assert.ok(recap.includes('الخميس'));

  // The agent reads the recap aloud; the caller says yes.
  s.live.emit('outputTranscription', recap);
  s.live.emit('inputTranscription', 'نعم صحيح');

  s.live.emit('toolCall', call('confirm_booking', {}));
  await s.loop.settled();

  const confirmed = s.live.toolResponses[1][0].response.result;
  assert.equal(confirmed.ok, true);
  assert.ok(confirmed.ref);

  const rows = await s.app.store.listAppointments({ clinicId: CLINIC });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'call');
  assert.equal(rows[0].createdBy, 'bot');
  assert.equal(rows[0].patientWaId, WA);
  assert.equal(rows[0].ref, confirmed.ref);

  const created = ofType(s.events, 'appointment.created');
  assert.equal(created.length, 1);
  assert.equal(created[0].appointment.ref, confirmed.ref);

  // Both sides of the call are on the record the clinic will read.
  const script = s.loop.transcript();
  assert.ok(script.some((e) => e.who === 'patient' && e.text.includes('نحب نحجز')));
  assert.ok(script.some((e) => e.who === 'agent' && e.text.includes(recap)));

  const outcome = s.loop.outcome();
  assert.equal(outcome.booked, confirmed.ref);
  assert.equal(outcome.emergency, false);
  assert.equal(outcome.handoff, false);
  assert.equal(outcome.toolCalls, 2);
  assert.equal(outcome.codec, 'opus');
});

// ── 2. the gate, end to end ─────────────────────────────────────────────────

test('REGRESSION: stage + confirm in ONE toolCall frame books NOTHING', async (t) => {
  // The end-to-end twin of the tools-level test: a single frame carrying both
  // calls is ONE batch, so the recap cannot have been spoken, so the gate holds.
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('toolCall', [
    {
      id: 'a',
      name: 'stage_booking',
      args: { specialty: 'cardiology', datetimeText: 'الخميس 10', name: 'محمد', contact: '21650123456' },
    },
    { id: 'b', name: 'confirm_booking', args: {} },
  ]);
  await s.loop.settled();

  const [staged, confirmed] = s.live.toolResponses[0];
  assert.equal(staged.response.result.ok, true);
  assert.equal(confirmed.response.result.ok, false);
  assert.equal(confirmed.response.result.error, 'read_recap_first');
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0);
  assert.equal(s.loop.outcome().booked, null);
  assert.equal(s.loop.transcript().length, 0, 'the caller never said a word');
});

test('a model that confirms without staging books NOTHING', async (t) => {
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('toolCall', call('confirm_booking', {}));
  await s.loop.settled();

  const result = s.live.toolResponses[0][0].response.result;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'nothing_staged');
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0);
  assert.equal(ofType(s.events, 'appointment.created').length, 0);
  assert.equal(s.loop.outcome().booked, null);
});

test('a cancelled stage cannot be confirmed afterwards', async (t) => {
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit(
    'toolCall',
    call('stage_booking', { specialty: 'dental', datetimeText: 'الخميس 10', name: 'Ali', contact: '21650111222' }, 'tc1')
  );
  await s.loop.settled();
  assert.equal(s.loop.stats().staged, true);

  s.live.emit('toolCallCancellation', ['tc1']);
  assert.equal(s.loop.stats().staged, false, 'a cancelled stage must not stay confirmable');

  s.live.emit('toolCall', call('confirm_booking', {}, 'tc2'));
  await s.loop.settled();
  assert.equal(s.live.toolResponses.at(-1)[0].response.result.error, 'nothing_staged');
  assert.equal((await s.app.store.listAppointments({ clinicId: CLINIC })).length, 0);
});

// ── 3. the emergency override ───────────────────────────────────────────────

test('an emergency mid-call: OUR detector speaks, staff are paged, the call ends', async (t) => {
  const ended = [];
  const s = await setup({ config: { voiceBrainEmergencyGraceMs: 30 }, ended });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  const greeting = s.live.sentText.length;

  // Queue some outbound speech so we can prove it is thrown away.
  s.live.emit('audio', tone24k(60));
  assert.ok(s.loop.stats().outQueue > 0);

  s.live.emit('inputTranscription', 'عندي وجع قوي في صدري و');
  await s.loop.settled();

  // 1) The agent is DICTATED the exact localized script — it never decides this.
  //    The SPOKEN variant: no emoji, no newline, the number read digit by digit
  //    because "one nine zero" is what a frightened caller can actually act on.
  const spoken = buildSpokenEmergencyReply(s.clinic, 'ar');
  const written = buildEmergencyReply(s.clinic, 'ar');
  const override = s.live.sentText.slice(greeting).find((x) => x.includes('EMERGENCY OVERRIDE'));
  assert.ok(override, 'the model was handed the script');
  assert.ok(override.includes(spoken), 'word for word, ours, not its own');
  assert.ok(!override.includes('🚨'), 'nobody reads an emoji out loud');
  assert.ok(!spoken.includes('\n'));
  assert.ok(spoken.includes('1 9 0'), 'the emergency number is speakable');
  assert.ok(/STOP TALKING/.test(override));
  assert.equal(s.loop.stats().outQueue, 0, 'queued small talk is dropped so the script goes out first');

  // 2) The owner is alerted.
  const [alert] = ofType(s.events, 'emergency.detected');
  assert.ok(alert);
  assert.equal(alert.tenantId, CLINIC);
  assert.equal(alert.conversationId, s.convo.id);
  assert.equal(alert.category, 'chest_pain');
  assert.equal(alert.patientWaId, WA);
  assert.equal(alert.channel, 'call');

  // 3) The bot steps back on EVERY channel, not just this call.
  const convo = await s.app.store.conversations.getById(CLINIC, s.convo.id);
  assert.equal(convo.status, 'needs_human');
  assert.equal(convo.aiPaused, true);

  // 4) The number is IN WRITING — nobody in distress retains one heard once.
  const msgs = await s.app.store.conversations.listMessages(CLINIC, s.convo.id, {});
  const out = msgs.filter((m) => m.direction === 'outbound');
  assert.equal(out.length, 1);
  assert.equal(out[0].body.text, written, 'the WhatsApp copy keeps the original written form');
  assert.equal(out[0].body.by, 'bot');

  // 5) …and the call ends on a TIMER, whether or not the model complied.
  await sleep(90);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'emergency');
  assert.equal(ended[0].emergency, true);
  assert.equal(s.live.closed, 1);
});

test('REGRESSION: nothing can interrupt the emergency script once it is dictated', async (t) => {
  // Before the fix, the generic barge-in handler flushed the outbound queue on
  // `interrupted` — including the ambulance number the caller was mid-way
  // through hearing. And the caller's own audio kept flowing to Gemini, whose
  // server VAD would abort generation for the same reason. A frightened caller
  // talks over you; that is the ONE moment we must talk over them.
  const ended = [];
  const s = await setup({ config: { voiceBrainEmergencyGraceMs: 40 }, ended });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('inputTranscription', 'عندي وجع قوي في صدري');
  await s.loop.settled();
  assert.equal(s.loop.outcome().emergency, true);

  // The model starts speaking the script; the caller talks over it.
  s.live.emit('audio', tone24k(200));
  const queued = s.loop.stats().outQueue;
  assert.ok(queued >= 8, 'the script is queued');
  s.live.emit('interrupted', true);
  assert.equal(s.loop.stats().outQueue, queued, 'the script survives the interruption');

  // …and their audio no longer reaches the brain, so server VAD cannot abort it.
  const before = s.live.audioChunks.length;
  s.live.emit('audio', tone24k(20));
  await sleep(40);
  const payload = s.media.sent.at(-1).subarray(12);
  s.loop.onRtp({ header: { payloadType: 111 }, payload });
  assert.equal(s.live.audioChunks.length, before, 'the uplink is muted during the script');

  // The call still ends on schedule, whether or not the model complied.
  await sleep(90);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'emergency');
});

test('REGRESSION: emergency words from SEPARATE turns do not add up', async (t) => {
  // Execution-proven false positive: "عندي وجع في ركبتي" (my knee hurts) in one
  // turn plus "نحب نعرف على تصوير الصدر" (chest imaging) in the next tripped the
  // chest_pain co-occurrence rule — ambulance script and a terminated call, on a
  // routine booking enquiry. The window exists to rejoin fragments of ONE
  // utterance, so the agent taking the floor clears it.
  const s = await setup({ config: { voiceBrainEmergencyGraceMs: 5000 } });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('inputTranscription', 'عندي وجع في ركبتي');
  s.live.emit('outputTranscription', 'أهلا، نجم نعاونك'); // the agent replies
  s.live.emit('inputTranscription', 'نحب نعرف على تصوير الصدر');
  await s.loop.settled();

  assert.equal(ofType(s.events, 'emergency.detected').length, 0, 'a knee and a chest X-ray are not a heart attack');
  assert.equal(s.loop.outcome().emergency, false);
  const msgs = await s.app.store.conversations.listMessages(CLINIC, s.convo.id, {});
  assert.equal(msgs.filter((m) => m.direction === 'outbound').length, 0);
});

test('turnComplete also clears the utterance window', async (t) => {
  const s = await setup({ config: { voiceBrainEmergencyGraceMs: 5000 } });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('inputTranscription', 'عندي وجع في ركبتي');
  s.live.emit('turnComplete', true);
  assert.equal(s.loop.stats().emergencyWindow, '', 'the window is reset when the turn ends');
  s.live.emit('inputTranscription', 'تصوير الصدر بقداش؟');
  await s.loop.settled();
  assert.equal(ofType(s.events, 'emergency.detected').length, 0);
});

test('the emergency fires exactly once, even as the caller keeps talking', async (t) => {
  const s = await setup({ config: { voiceBrainEmergencyGraceMs: 5000 } });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('inputTranscription', 'نزيف');
  s.live.emit('inputTranscription', ' الدم ما يوقفش');
  s.live.emit('inputTranscription', ' عاونوني');
  await s.loop.settled();

  assert.equal(ofType(s.events, 'emergency.detected').length, 1, 'one alert, not three');
  const msgs = await s.app.store.conversations.listMessages(CLINIC, s.convo.id, {});
  assert.equal(msgs.filter((m) => m.direction === 'outbound').length, 1);
});

test('an emergency spread across transcription fragments is still caught', async (t) => {
  const s = await setup({ config: { voiceBrainEmergencyGraceMs: 5000 } });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  // Gemini streams words, not sentences. A detector fed one fragment at a time
  // would never see "chest" and "pain" together — hence the rolling window.
  for (const frag of ['عندي ', 'وجع ', 'في ', 'صدري']) s.live.emit('inputTranscription', frag);
  await s.loop.settled();
  assert.equal(ofType(s.events, 'emergency.detected').length, 1);
});

// ── 4. barge-in ─────────────────────────────────────────────────────────────

test('barge-in flushes every queued frame the instant the caller speaks over us', async (t) => {
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('audio', tone24k(200)); // 10 frames of speech queued
  const queued = s.loop.stats().outQueue;
  assert.ok(queued >= 8, `expected a full queue, got ${queued}`);
  assert.ok(s.loop.stats().codec.pendingSamples >= 0);

  s.live.emit('interrupted', true);
  assert.equal(s.loop.stats().outQueue, 0, 'nothing queued survives the interruption');
  assert.equal(s.loop.stats().codec.pendingSamples, 0, 'not even the half-encoded frame');
});

// ── 5. the wire ─────────────────────────────────────────────────────────────

test('pacer catches up after an event-loop stall — the stream stays real-time', async (t) => {
  // Regression for the first live call (2026-07-31): one-frame-per-tick pacing
  // let Windows timer drift starve the stream — 10 s of speech took ~30 s to
  // send and the caller heard choppy, dragging audio. The pacer must send
  // every frame that is DUE by wall clock, not one per timer callback.
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('audio', tone24k(600)); // 30 frames of queued speech
  await sleep(40); // pacing begins
  const before = s.media.sent.length;
  const t0 = Date.now();
  while (Date.now() - t0 < 300) {
    // synchronous stall — timers cannot fire, exactly like a loaded event loop
  }
  await sleep(80); // one healthy tick after the stall must burst the backlog
  const sent = s.media.sent.length - before;
  assert.ok(sent >= 15, `only ${sent} frames left the pacer after a 300 ms stall`);
});

test('outbound RTP is a well-formed, monotonic 20 ms stream', async (t) => {
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('audio', tone24k(120));
  // Poll instead of a fixed sleep: the pacer is a real 20 ms setInterval, and
  // a fixed 200 ms window flakes when the full parallel suite starves the
  // event loop (confirmed under load: "only 3 packets were paced out").
  const deadline = Date.now() + 5000;
  while (s.media.sent.length < 4 && Date.now() < deadline) await sleep(25);

  assert.ok(s.media.sent.length >= 4, `only ${s.media.sent.length} packets were paced out`);
  let prevSeq = null;
  let prevTs = null;
  for (const pkt of s.media.sent) {
    assert.ok(Buffer.isBuffer(pkt), 'werift.writeRtp deserializes a Buffer for us');
    assert.equal(pkt[0], 0x80, 'RTP version 2, no padding, no CSRC');
    assert.equal(pkt[1] & 0x7f, 111, 'the NEGOTIATED payload type');
    assert.ok(pkt.length > 12, 'there is an actual payload');
    const seq = pkt.readUInt16BE(2);
    const ts = pkt.readUInt32BE(4);
    if (prevSeq != null) {
      assert.equal((seq - prevSeq) & 0xffff, 1, 'sequence numbers are contiguous');
      assert.equal((ts - prevTs) >>> 0, 960, '20 ms at 48 kHz is 960 timestamp units');
    }
    prevSeq = seq;
    prevTs = ts;
  }
  assert.equal((s.media.sent[0][1] & 0x80) !== 0, true, 'the marker bit opens a talkspurt');
  assert.equal(s.media.sent.every((p) => p.readUInt32BE(8) === s.media.sent[0].readUInt32BE(8)), true, 'one SSRC per call');
});

test('inbound RTP is decoded and streamed to the brain; junk is swallowed', async (t) => {
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  // Round-trip a real Opus frame through the loop's own codec.
  s.live.emit('audio', tone24k(20));
  await sleep(40);
  const payload = s.media.sent[0].subarray(12);

  s.loop.onRtp({ header: { payloadType: 111 }, payload });
  assert.equal(s.live.audioChunks.length, 1);
  assert.equal(s.live.audioChunks[0].length, 320, '20 ms at the brain\'s 16 kHz');

  // Nothing below may throw into werift's receive path.
  for (const junk of [null, {}, { payload: Buffer.alloc(0) }, { header: {}, payload: Buffer.from([0xff, 0x01]) }]) {
    s.loop.onRtp(junk);
  }
});

// ── 6. DTMF (noisy lines) ───────────────────────────────────────────────────

test('DTMF 1 starts booking and DTMF 2 hands off, each firing once per press', async (t) => {
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  const base = s.live.sentText.length;

  // RFC 4733: the same event repeats every 20 ms while the key is held.
  const press = (event, end = false) => ({
    header: { payloadType: 101 },
    payload: Buffer.from([event, end ? 0x8a : 0x0a, 0x00, 0xa0]),
  });

  s.loop.onRtp(press(1));
  s.loop.onRtp(press(1));
  s.loop.onRtp(press(1));
  assert.equal(s.live.sentText.length, base + 1, 'a held key is ONE press');
  assert.match(s.live.sentText.at(-1), /pressed 1/);
  s.loop.onRtp(press(1, true));

  s.loop.onRtp(press(2));
  await s.loop.settled();
  assert.match(s.live.sentText.at(-1), /pressed 2/);

  const [handoff] = ofType(s.events, 'handoff.requested');
  assert.ok(handoff, 'the keypad shortcut goes through the same tool as the spoken one');
  assert.equal(handoff.handoff.reason, 'dtmf_2');
  assert.equal(s.loop.outcome().handoff, true);
});

test('a DTMF payload the loop does not understand is ignored, not crashed on', async (t) => {
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  const base = s.live.sentText.length;
  s.loop.onRtp({ header: { payloadType: 101 }, payload: Buffer.from([0x05, 0x0a, 0, 0xa0]) }); // '5'
  s.loop.onRtp({ header: { payloadType: 101 }, payload: Buffer.from([0x01]) }); // truncated
  assert.equal(s.live.sentText.length, base);
});

// ── 7. degrade ──────────────────────────────────────────────────────────────

for (const [label, event, payload] of [
  ['an error', 'error', new Error('socket reset')],
  ['a goAway', 'goAway', { timeLeft: '2s' }],
  ['a close', 'close', {}],
]) {
  test(`${label} from the brain ends the loop with outcome brain_lost`, async (t) => {
    const ended = [];
    const s = await setup({ ended });
    t.after(() => s.unsub());
    await s.loop.start();

    s.live.emit(event, payload);

    assert.equal(ended.length, 1, 'the service is told exactly once');
    assert.equal(ended[0].reason, 'brain_lost');
    assert.equal(s.live.closed, 1);
    assert.equal(s.loop.outcome().reason, 'brain_lost');
    // The loop reports; it never hangs up the call itself.
    assert.equal(s.loop.stats().pacing, false);
  });
}

test('a brain that never completes setup rejects start() so the service can degrade', async (t) => {
  const s = await setup({ autoReady: false });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  const started = s.loop.start();
  s.live.failSetup(new Error('live setup timed out after 6000ms'));
  await assert.rejects(started, /timed out/);
});

// ── 8. housekeeping ─────────────────────────────────────────────────────────

test('stop() is idempotent, fires onEnd once, and leaves no timer behind', async (t) => {
  const ended = [];
  const s = await setup({ ended });
  t.after(() => s.unsub());
  await s.loop.start();
  s.live.emit('audio', tone24k(40));
  assert.equal(s.loop.stats().pacing, true);

  const first = s.loop.stop('call_ended');
  const second = s.loop.stop('something_else');

  assert.equal(ended.length, 1);
  assert.equal(first.reason, 'call_ended');
  assert.equal(second.reason, 'call_ended', 'the first reason is the real one');
  assert.equal(s.live.closed, 1);
  assert.equal(s.loop.stats().pacing, false);
  assert.equal(s.loop.stats().outQueue, 0);

  // A stopped loop must go inert rather than half-work.
  s.live.emit('audio', tone24k(40));
  assert.equal(s.loop.stats().outQueue, 0);
  s.loop.onRtp({ header: { payloadType: 111 }, payload: Buffer.from([1, 2, 3]) });
  assert.equal(s.live.audioChunks.length, 0);
});

test('the transcript merges streamed fragments and is capped at the tail', async (t) => {
  const s = await setup();
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  s.live.emit('inputTranscription', 'صباح ');
  s.live.emit('inputTranscription', 'الخير');
  s.live.emit('outputTranscription', 'أهلا بيك');
  let script = s.loop.transcript();
  assert.equal(script.length, 2, 'consecutive fragments from one speaker become one entry');
  assert.equal(script[0].text, 'صباح الخير');
  assert.ok(script[0].at, 'entries are timestamped');

  // A long call must not grow without bound in the conversation row.
  for (let i = 0; i < 60; i += 1) {
    s.live.emit('outputTranscription', 'x'.repeat(200));
    s.live.emit('inputTranscription', 'y'.repeat(200));
  }
  script = s.loop.transcript();
  const total = script.reduce((n, e) => n + e.text.length, 0);
  assert.ok(total <= 8000, `transcript grew to ${total} chars`);
  assert.ok(script.at(-1).text.endsWith('y'), 'the END of the call is what is kept');
});

test('a facilitator loop books nothing but CAPTURES the lead', async (t) => {
  const s = await setup({ tenantId: 'medtour-tripoli-sousse' });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();

  assert.deepEqual(s.live.opts.tools.map((d) => d.name), ['capture_lead', 'request_handoff']);
  assert.ok(s.live.opts.systemInstruction.includes('THE AGENCY BOOKS NOTHING'));
  assert.ok(
    s.live.opts.systemInstruction.includes('CALL capture_lead'),
    'the prompt orders capture BEFORE the same-day-offer promise'
  );

  s.live.emit('toolCall', call('stage_booking', { datetimeText: 'غدوة', name: 'X' }));
  await s.loop.settled();
  assert.equal(s.live.toolResponses[0][0].response.result.error, 'booking_not_supported');

  s.live.emit(
    'toolCall',
    call('capture_lead', { procedure: 'زراعة أسنان', originCity: 'طرابلس', travelWindow: 'الشهر الجاي' })
  );
  await s.loop.settled();
  assert.equal(s.live.toolResponses[1][0].response.result.ok, true);

  const [hot] = ofType(s.events, 'lead.hot');
  assert.ok(hot, 'the agency owner is pinged on a qualified call');
  assert.equal(hot.lead.reason, 'facilitator_qualified');
  assert.equal(s.loop.outcome().lead.procedure, 'زراعة أسنان');

  const leads = await s.app.store.leads.list('medtour-tripoli-sousse', {});
  assert.equal(leads.length, 1);
  assert.equal(leads[0].details.reason, 'facilitator_qualified_voice');
});

test('a facilitator keypad "1" starts QUALIFICATION, never a booking flow', async (t) => {
  const s = await setup({ tenantId: 'medtour-tripoli-sousse' });
  t.after(() => {
    s.unsub();
    s.loop.stop('test');
  });
  await s.loop.start();
  const base = s.live.sentText.length;

  s.loop.onRtp({ header: { payloadType: 101 }, payload: Buffer.from([1, 0x0a, 0x00, 0xa0]) });
  const said = s.live.sentText.at(-1);
  assert.equal(s.live.sentText.length, base + 1);
  assert.match(said, /qualification questions/);
  assert.ok(!/booking flow/.test(said), 'an agency has no calendar to offer');
});

test('the degrade text the service will send is a real localized string', () => {
  // Guards against the key being added to only one language, which would ship
  // an empty WhatsApp message on the exact path that is supposed to save a lead.
  for (const lang of ['ar', 'fr', 'en']) {
    assert.ok(tr(lang, 'callBrainLost').length > 30, `callBrainLost missing for ${lang}`);
    assert.ok(tr(lang, 'callBookedSummary', { duration: '1:20', ref: 'EAS-1' }).includes('EAS-1'));
    assert.ok(tr(lang, 'callRecap', { specialty: 'S', when: 'W', name: 'N', contact: 'C' }).includes('N'));
  }
});
