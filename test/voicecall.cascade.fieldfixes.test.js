// V8 SELF-TEST FIELD FIXES — three bugs found by scripts/call-selftest.js on
// real rehearsal calls, 2026-08-02, and the regressions that hold them fixed.
//
// Each of these was invisible in the suite because each needs a REAL vendor to
// misbehave: a Gemini 3 tool round, a Live socket dying mid-call, and a
// transcriber that answers derja in Latin script. The self-test found all three
// in four calls, which is the argument for the self-test.
//
// Hermetic, like the rest of the voice suite: nothing here opens a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGeminiContents } from '../src/voice-call/brain-cascade/llm/geminiText.js';
import { describeLlmDetail } from '../src/voice-call/brain-cascade/llm/index.js';
import { createSttChain } from '../src/voice-call/brain-cascade/stt/index.js';
import { isBackchannelOnly, BACKCHANNELS } from '../src/voice-call/brain-cascade/turnTaking.js';
import { createLiveEarsStt, EARS_PATIENT_IDLE_MS } from '../src/voice-call/brain-cascade/stt/liveEars.js';

// ════════════════════════════════════════════════════════════════════════════
// 1. THE THOUGHT SIGNATURE — the demo-fatal one
// ════════════════════════════════════════════════════════════════════════════
// Gemini 3.x returns an opaque `thoughtSignature` beside every functionCall part
// and REQUIRES it echoed in the follow-up request carrying the functionResponse.
// Rebuilding the part from name+args alone 400'd the round-2 request of the
// first tool-calling turn of EVERY call — which is every booking — and `classic`
// then took the call sticky and answered the rest with «ما فهمتش قصدك».

test('a functionCall part carries its thought signature back to Gemini', () => {
  const contents = toGeminiContents([
    { role: 'user', text: 'نحب نحجز موعد' },
    {
      role: 'assistant',
      text: 'ثانية برك…',
      toolCalls: [{ id: 'c1', name: 'get_available_slots', args: { day: 'thursday' }, thoughtSignature: 'SIG-ABC' }],
    },
    { role: 'tool', name: 'get_available_slots', result: { ok: true, slots: [] } },
  ]);

  const modelTurn = contents.find((c) => c.role === 'model');
  const fcPart = modelTurn.parts.find((p) => p.functionCall);
  assert.equal(fcPart.functionCall.name, 'get_available_slots');
  assert.equal(
    fcPart.thoughtSignature,
    'SIG-ABC',
    'without this the API answers HTTP 400 "Function call is missing a thought_signature"'
  );
  // The signature sits on the PART, never inside functionCall — putting it there
  // is an unknown field and 400s just as hard.
  assert.equal(fcPart.functionCall.thoughtSignature, undefined);
});

test('a tool call WITHOUT a signature emits no key at all (never a null)', () => {
  // Cerebras/Groq/classic produce tool calls too, and `thoughtSignature: null`
  // is an explicit null in the JSON body — which v1beta rejects as a bad type
  // rather than ignoring.
  for (const call of [
    { name: 't', args: {} },
    { name: 't', args: {}, thoughtSignature: null },
    { name: 't', args: {}, thoughtSignature: '' },
  ]) {
    const [content] = toGeminiContents([{ role: 'assistant', toolCalls: [call] }]);
    const part = content.parts[0];
    assert.ok(!('thoughtSignature' in part), `${JSON.stringify(call)} must not add the key`);
  }
});

test('the tool ROUND-TRIP shape is unchanged otherwise', () => {
  // The functionResponse still rides in a `user` content — the shape v1beta
  // accepts, and the thing the signature fix must not have disturbed.
  const contents = toGeminiContents([
    { role: 'assistant', toolCalls: [{ name: 'stage_booking', args: { name: 'محمد' }, thoughtSignature: 'S' }] },
    { role: 'tool', name: 'stage_booking', result: { ok: false, error: 'missing_contact' } },
  ]);
  assert.deepEqual(contents.map((c) => c.role), ['model', 'user']);
  assert.equal(contents[1].parts[0].functionResponse.name, 'stage_booking');
  assert.deepEqual(contents[1].parts[0].functionResponse.response.result, {
    ok: false,
    error: 'missing_contact',
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE VENDOR'S OWN WORDS IN THE ROTATION LINE
// ════════════════════════════════════════════════════════════════════════════
// `LLM gemini-flash-lite-latest failed (returned HTTP 400) — rotating to …` was
// the WHOLE log line. The body naming the field was already on the error and
// was simply thrown away, which cost a rehearsal night.

test('describeLlmDetail prints the vendor body, flattened and capped', () => {
  const err = {
    detail: '{\n  "error": {\n    "code": 400,\n    "message": "Function call is missing a thought_signature"\n  }\n}',
  };
  const s = describeLlmDetail(err);
  assert.match(s, /^: /);
  assert.match(s, /thought_signature/);
  assert.ok(!s.includes('\n'), 'a multi-line body must not break the log into pieces');
  assert.ok(s.length <= 202);
});

test('describeLlmDetail redacts an echoed API key and tolerates nothing', () => {
  assert.match(
    describeLlmDetail({ detail: 'bad request for /v1beta/models/x?alt=sse&key=AIzaSyREALKEY123' }),
    /key=REDACTED/
  );
  assert.ok(!describeLlmDetail({ detail: 'x?key=AIzaSyREALKEY123' }).includes('AIzaSyREALKEY123'));
  for (const nothing of [undefined, null, {}, { detail: '' }, { detail: '   ' }]) {
    assert.equal(describeLlmDetail(nothing), '', `${JSON.stringify(nothing)} must add nothing to the line`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. A MID-CALL EARS DEATH NAMES ITS CLOSE CODE
// ════════════════════════════════════════════════════════════════════════════
// `socket closed` with no code is not a diagnosis: 1008 (policy/quota), 1011
// (server) and a clean 1000 are three incidents with three fixes.

/**
 * A minimal fake GEMINI LIVE SESSION — which is what `liveFactory` builds. The
 * chain wraps it in the real createLiveEarsStt, so these tests exercise the
 * production adapter and only the socket is imaginary.
 */
function fakeLiveSession() {
  const handlers = new Map();
  return {
    ready: Promise.resolve(true),
    sendAudioChunk() {},
    on(ev, cb) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(cb);
      return () => {};
    },
    fire(ev, payload) {
      for (const cb of [...(handlers.get(ev) || [])]) cb(payload);
    },
    /** What liveEars turns into one complete caller utterance. */
    saySomething(text) {
      this.fire('inputTranscription', text);
      this.fire('turnComplete');
    },
    close() {},
    stats: () => ({}),
  };
}

/** A chain with liveEars as its ONLY (and therefore last) rung. */
function earsOnlyChain({ sessions, logs, ready = true }) {
  return createSttChain({
    config: { geminiApiKey: 'k' },
    liveFactory: () => {
      const s = fakeLiveSession();
      if (!ready) {
        s.ready = Promise.reject(new Error('live setup timed out'));
        s.ready.catch(() => {});
      }
      sessions.push(s);
      return s;
    },
    logger: (...a) => logs.push(a.join(' ')),
  });
}

test('a mid-call ears close reports the code and reason', async () => {
  const sessions = [];
  const logs = [];
  const chain = earsOnlyChain({ sessions, logs });
  await chain.ready;
  assert.equal(sessions.length, 1);

  // First death: relit (see the next test) — and the line already names the code.
  sessions[0].fire('close', { code: 1008, reason: 'quota exceeded' });
  await new Promise((r) => setTimeout(r, 20));
  const relight = logs.find((l) => l.includes('relighting it ONCE'));
  assert.ok(relight, 'a working leg that dies is relit');
  assert.match(relight, /code 1008/, 'the close code is the whole diagnosis');
  assert.match(relight, /quota exceeded/);

  // Second death: the chain is out of options, and says why with the same detail.
  sessions[1].fire('close', { code: 1008, reason: 'quota exceeded' });
  await new Promise((r) => setTimeout(r, 20));
  const exhausted = logs.find((l) => l.includes('STT chain exhausted'));
  assert.ok(exhausted, 'a dead last rung must be reported');
  assert.match(exhausted, /code 1008/);
  assert.match(exhausted, /quota exceeded/);
  chain.close();
});

// ── 3b. …AND THE LAST RUNG GETS ONE SECOND CHANCE ──────────────────────────
// A vendor 1011 on the ONLY configured leg used to end the call outright: the
// caller was hung up on and apologised to on WhatsApp because somebody else's
// server had a bad second.

test('a working last rung that dies is relit ONCE instead of losing the call', async () => {
  const sessions = [];
  const logs = [];
  const lost = [];
  const finals = [];
  const chain = earsOnlyChain({ sessions, logs });
  chain.on('lost', (e) => lost.push(e));
  chain.on('final', (ev) => finals.push(ev.text));
  await chain.ready;
  sessions[0].saySomething('نحب نحجز موعد');
  assert.deepEqual(finals, ['نحب نحجز موعد'], 'the first session was working');

  // A vendor blip on a session that was transcribing perfectly.
  sessions[0].fire('close', { code: 1011, reason: 'Internal error encountered.' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sessions.length, 2, 'a fresh session was opened rather than the call being dropped');
  assert.equal(lost.length, 0, 'the call must NOT have been lost');
  assert.match(logs.join('\n'), /relighting it ONCE/);
  assert.equal(chain.stats().relights, 1);

  // THE POINT: the caller keeps talking and is still heard.
  sessions[1].saySomething('طبيب القلب');
  assert.deepEqual(finals, ['نحب نحجز موعد', 'طبيب القلب']);

  // …and a SECOND death is a real outage: one relight, never a loop.
  sessions[1].fire('close', { code: 1011, reason: 'Internal error encountered.' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sessions.length, 2, 'no reconnect loop against a vendor that is genuinely down');
  assert.equal(lost.length, 1, 'the second death exhausts the chain exactly as before');
  assert.match(logs.join('\n'), /STT chain exhausted/);
  chain.close();
});

test('a leg that NEVER connected is not relit — that path already rotates', async () => {
  const sessions = [];
  const logs = [];
  const lost = [];
  const chain = earsOnlyChain({ sessions, logs, ready: false });
  chain.on('lost', (e) => lost.push(e));
  await chain.ready;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sessions.length, 1, 'a connect failure must not buy a second attempt');
  assert.equal(lost.length, 1);
  assert.equal(chain.stats().relights, 0);
  chain.close();
});

test('a close with no code still reads as a plain socket close', async () => {
  const sessions = [];
  const logs = [];
  const chain = earsOnlyChain({ sessions, logs });
  await chain.ready;
  sessions[0].fire('close', undefined); // relit
  await new Promise((r) => setTimeout(r, 20));
  sessions[1].fire('close', undefined); // exhausted
  await new Promise((r) => setTimeout(r, 20));
  const exhausted = logs.find((l) => l.includes('STT chain exhausted'));
  assert.ok(exhausted);
  assert.match(exhausted, /socket closed/);
  assert.ok(!/code \d/.test(exhausted), 'no code ⇒ no invented one');
  chain.close();
});

// ════════════════════════════════════════════════════════════════════════════
// 4. A BACKCHANNEL IN LATIN IS STILL A BACKCHANNEL
// ════════════════════════════════════════════════════════════════════════════
// liveEars answered «باهي» with "Bahi". The ignore-list held only the Arabic
// spelling, so it became a full LLM turn — the exact interruption D3 §2 exists
// to prevent — and the agent asked the caller a question they had not invited.

test('the Latin spellings liveEars produces for derja are backchannels too', () => {
  for (const said of ['Bahi', 'bahi', 'behi', 'Tamem', 'tamam', 'Aywa', 'ayweh', 'Tayeb', 'naam', 'sahh', 'haw']) {
    assert.equal(isBackchannelOnly(said), true, `«${said}» must never stop the agent mid-sentence`);
  }
  // …and with the trailing punctuation a transcriber adds.
  assert.equal(isBackchannelOnly('Bahi.'), true);
  assert.equal(isBackchannelOnly('bahi, ok'), true);
});

test('every Latin entry added is a second spelling of an existing one, not a new word', () => {
  // The guard on this list: it may only ever grow with respellings. A genuinely
  // new word slipping in here would silently stop being answerable on a call.
  const LATIN_ADDED = ['bahi', 'behi', 'baheh', 'tayeb', 'taib', 'tamem', 'tamam', 'aywa', 'ayweh', 'aywah', 'naam', 'nam', 'sahh', 'haw'];
  for (const w of LATIN_ADDED) assert.ok(BACKCHANNELS.has(w), `${w} is missing from the ignore-list`);
  // The Arabic originals they respell are all still there.
  for (const w of ['باهي', 'طيب', 'تمام', 'ايوا', 'نعم', 'صح', 'هاو']) {
    assert.ok(BACKCHANNELS.has(w), `${w} must not have been dropped`);
  }
});

test('real speech is still a turn — the list did not become greedy', () => {
  for (const said of [
    'نحب نحجز موعد',
    'bahi nheb nahjez maw3ed', // a backchannel PREFIXING a real sentence
    'ok but I need cardiology',
    'tamam wa9tach',
    'محمد الهادي',
  ]) {
    assert.equal(isBackchannelOnly(said), false, `«${said}» is a caller taking the floor`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 5. A PHONE NUMBER READ WITH A PAUSE IS ONE UTTERANCE
// ════════════════════════════════════════════════════════════════════════════
// V8-D2 §1 lent liveEars the patient (1200 ms) idle timer for data-capture
// turns, but the vendor's own `turnComplete` called flushFinal() directly and
// the patient timer never got a vote. Measured on a self-test booking call:
// «واحد وعشرين تسعة وعشرين» + pause + «أربعة تسعة ستة سبعة» arrived as TWO
// finals, stage_booking saw half a number and refused for `missing_contact`.

function earsOn({ capturing = () => false, idleMs = 40, patientIdleMs = 200 } = {}) {
  const session = fakeLiveSession();
  const finals = [];
  const ears = createLiveEarsStt({
    config: { geminiApiKey: 'k' },
    liveFactory: () => session,
    dataCapture: capturing,
    idleMs,
    patientIdleMs,
    logger: () => {},
  });
  ears.on('final', (ev) => finals.push(ev.text));
  return { session, ears, finals };
}

test('the patient endpointer is longer than the ordinary one', () => {
  assert.ok(EARS_PATIENT_IDLE_MS > 700, 'a data-capture turn must be more patient than a normal one');
});

test('a mid-number pause does NOT end the turn while collecting data', async () => {
  const { session, ears, finals } = earsOn({ capturing: () => true });

  session.fire('inputTranscription', '21 29');
  // Gemini Live's VAD decides the caller finished — mid-number.
  session.fire('turnComplete');
  assert.deepEqual(finals, [], 'the vendor must not be allowed to cut a number in half');

  // The caller reads the rest a beat later, into the SAME utterance.
  session.fire('inputTranscription', ' 49 67');
  session.fire('turnComplete');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(finals, ['21 29 49 67'], 'one number, one final');
  assert.equal(ears.stats().vendorEndsOverruled, 1);
  ears.close();
});

test('a held turn still ends on its own if the caller says no more', async () => {
  const { session, ears, finals } = earsOn({ capturing: () => true, patientIdleMs: 120 });
  session.fire('inputTranscription', '21 29');
  session.fire('turnComplete');
  assert.deepEqual(finals, []);
  // Nothing else arrives. A HELD final is never a LOST final.
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(finals, ['21 29'], 'the patient timer always closes the utterance');
  ears.close();
});

test('the hold is ONE per utterance — a trickling caller cannot hold the line open', async () => {
  const { session, ears, finals } = earsOn({ capturing: () => true, patientIdleMs: 5000 });
  session.fire('inputTranscription', 'a');
  session.fire('turnComplete'); // held
  session.fire('inputTranscription', 'b');
  session.fire('turnComplete'); // NOT held — flushed immediately
  assert.deepEqual(finals, ['ab']);
  assert.equal(ears.stats().vendorEndsOverruled, 1);
  ears.close();
});

test('OUTSIDE a data-capture state the vendor still ends the turn instantly', async () => {
  const { session, ears, finals } = earsOn({ capturing: () => false, patientIdleMs: 5000 });
  session.fire('inputTranscription', 'نحب نحجز موعد');
  session.fire('turnComplete');
  assert.deepEqual(finals, ['نحب نحجز موعد'], 'ordinary turns must not get slower');
  assert.equal(ears.stats().vendorEndsOverruled, 0);
  ears.close();
});

test('the NEXT utterance gets its own hold', async () => {
  const { session, ears, finals } = earsOn({ capturing: () => true, patientIdleMs: 120 });
  session.fire('inputTranscription', '21 29');
  session.fire('turnComplete');
  await new Promise((r) => setTimeout(r, 250));
  session.fire('inputTranscription', 'محمد');
  session.fire('turnComplete');
  assert.deepEqual(finals, ['21 29'], 'the second utterance is being held too');
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(finals, ['21 29', 'محمد']);
  assert.equal(ears.stats().vendorEndsOverruled, 2);
  ears.close();
});
