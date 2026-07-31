// Gemini Live client tests — the whole protocol surface, ZERO network.
//
// HERMETICITY LAW (repo rule, restated because this is the one file that could
// break it): no test may ever open a real WebSocket. Every test here injects a
// wsFactory, and the last test proves the module cannot reach the internet by
// accident — the factory is the only way a socket is ever constructed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveClient,
  AUDIO_CHUNK_SAMPLES,
  PRE_READY_MAX_SAMPLES,
} from '../src/voice-call/brain/liveClient.js';
import { int16ToBuffer, bufferToInt16 } from '../src/voice-call/brain/g711.js';

/**
 * A fake WebSocket: records every frame we send, lets the test drive the
 * server side by hand. `open` fires on the next tick so the client has finished
 * attaching its handlers first — exactly like a real socket.
 */
function fakeWs({ autoOpen = true, autoSetup = true } = {}) {
  const state = { sent: [], closed: 0, url: null, socket: null };
  const factory = (url) => {
    const ws = {
      url,
      send(raw) {
        const frame = JSON.parse(raw);
        state.sent.push(frame);
        // Behave like the real endpoint: answer `setup` with `setupComplete`.
        if (frame.setup && autoSetup) {
          setImmediate(() => ws.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }));
        }
      },
      close() {
        state.closed += 1;
      },
    };
    state.url = url;
    state.socket = ws;
    if (autoOpen) setImmediate(() => ws.onopen?.({}));
    return ws;
  };
  factory.state = state;
  factory.open = () => state.socket.onopen?.({});
  factory.deliver = (obj) => state.socket.onmessage?.({ data: JSON.stringify(obj) });
  factory.deliverBlob = (obj) =>
    state.socket.onmessage?.({ data: new Blob([JSON.stringify(obj)]) });
  factory.deliverRaw = (data) => state.socket.onmessage?.({ data });
  factory.serverClose = (code = 1006) => state.socket.onclose?.({ code });
  factory.serverError = (msg) => state.socket.onerror?.({ message: msg });
  factory.frames = (key) => state.sent.filter((f) => key in f);
  return factory;
}

function client(ws, over = {}) {
  return createLiveClient({
    apiKey: '',
    model: 'test-live-model',
    systemInstruction: 'BE SAFE',
    tools: [{ name: 'confirm_booking', parameters: { type: 'OBJECT', properties: {} } }],
    wsFactory: ws,
    readyTimeoutMs: 200,
    ...over,
  });
}

/** Collect every event a client emits, so a test can assert on order too. */
function record(live) {
  const seen = [];
  for (const ev of [
    'audio',
    'inputTranscription',
    'outputTranscription',
    'interrupted',
    'toolCall',
    'toolCallCancellation',
    'goAway',
    'turnComplete',
    'generationComplete',
    'close',
    'error',
    'usage',
  ]) {
    live.on(ev, (p) => seen.push([ev, p]));
  }
  return seen;
}

const b64 = (int16) => int16ToBuffer(int16).toString('base64');
const audioFrame = (int16) => ({
  serverContent: { modelTurn: { parts: [{ inlineData: { data: b64(int16), mimeType: 'audio/pcm;rate=24000' } }] } },
});

test('the setup frame carries the model, AUDIO modality, tools and BOTH transcriptions', async (t) => {
  const ws = fakeWs();
  const live = client(ws);
  t.after(() => live.close());
  await live.ready;

  const [setup] = ws.frames('setup');
  assert.ok(setup, 'setup is the very first frame');
  assert.equal(ws.state.sent[0], setup);
  const s = setup.setup;
  assert.equal(s.model, 'models/test-live-model', 'the model id is prefixed exactly once');
  assert.deepEqual(s.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(s.systemInstruction.parts[0].text, 'BE SAFE');
  assert.equal(s.tools[0].functionDeclarations[0].name, 'confirm_booking');
  assert.ok(s.realtimeInputConfig.automaticActivityDetection, 'server VAD drives barge-in');
  // Both are load-bearing, not diagnostics: input feeds OUR emergency detector,
  // output becomes the transcript the clinic reads.
  assert.deepEqual(s.inputAudioTranscription, {});
  assert.deepEqual(s.outputAudioTranscription, {});
});

test('an already-prefixed model id is not double-prefixed', async (t) => {
  const ws = fakeWs();
  const live = client(ws, { model: 'models/already' });
  t.after(() => live.close());
  await live.ready;
  assert.equal(ws.frames('setup')[0].setup.model, 'models/already');
});

test('ready resolves only on setupComplete, and isReady follows it', async (t) => {
  const ws = fakeWs({ autoSetup: false });
  const live = client(ws);
  t.after(() => live.close());
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(live.isReady, false, 'an open socket is not a ready session');
  ws.deliver({ setupComplete: {} });
  await live.ready;
  assert.equal(live.isReady, true);
});

test('ready rejects on a setup timeout rather than hanging the call', async () => {
  const ws = fakeWs({ autoSetup: false });
  const live = client(ws, { readyTimeoutMs: 25 });
  // The ready timer is deliberately unref'd (a stalled brain must never hold the
  // process open), so the test itself keeps the loop alive while it fires.
  const keepAlive = new Promise((r) => setTimeout(r, 80));
  await assert.rejects(live.ready, /timed out/);
  await keepAlive;
  live.close();
});

test('ready rejects when the socket closes or errors before setup', async () => {
  const a = fakeWs({ autoSetup: false });
  const liveA = client(a);
  await new Promise((r) => setTimeout(r, 5));
  a.serverClose(1006);
  await assert.rejects(liveA.ready, /closed/);

  const b = fakeWs({ autoSetup: false });
  const liveB = client(b);
  await new Promise((r) => setTimeout(r, 5));
  b.serverError('boom');
  await assert.rejects(liveB.ready, /boom/);
  liveB.close();
});

test('outbound audio is batched into ~100 ms realtimeInput messages', async (t) => {
  const ws = fakeWs();
  const live = client(ws);
  t.after(() => live.close());
  await live.ready;

  live.sendAudioChunk(new Int16Array(600));
  live.sendAudioChunk(new Int16Array(600));
  assert.equal(ws.frames('realtimeInput').length, 0, 'a partial 100 ms window is held');

  live.sendAudioChunk(new Int16Array(600));
  const msgs = ws.frames('realtimeInput');
  assert.equal(msgs.length, 1, '1800 samples go out as ONE message, not three');
  assert.equal(msgs[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  const decoded = bufferToInt16(Buffer.from(msgs[0].realtimeInput.audio.data, 'base64'));
  assert.equal(decoded.length, 1800);
  assert.ok(AUDIO_CHUNK_SAMPLES === 1600, 'the batch threshold is 100 ms @16 kHz');

  // flushAudio() pushes a partial window (end of turn / shutdown).
  live.sendAudioChunk(new Int16Array(100));
  live.flushAudio();
  assert.equal(ws.frames('realtimeInput').length, 2);
});

test('REGRESSION: nothing but `setup` is sent before setupComplete', async (t) => {
  // A protocol violation on EVERY real call before the fix: the media path
  // connects before the brain does, so the caller's first words were being
  // pushed at a socket that had not been acknowledged yet — which the endpoint
  // is entitled to answer by closing.
  const ws = fakeWs({ autoSetup: false });
  const live = client(ws);
  t.after(() => live.close());
  await new Promise((r) => setTimeout(r, 5));

  live.sendAudioChunk(new Int16Array(8000)); // half a second of "allo?"
  live.sendText('too early');
  live.sendToolResponse([{ id: 'x', name: 'y', result: {} }]);

  assert.equal(ws.state.sent.length, 1, 'exactly one frame went out');
  assert.ok(ws.state.sent[0].setup, '…and it is the setup');
  assert.equal(live.stats().preReadySamples, 8000, 'the audio was HELD, not dropped');

  // …and the moment the server acknowledges, the held audio goes out.
  ws.deliver({ setupComplete: {} });
  await live.ready;
  const audio = ws.frames('realtimeInput');
  assert.equal(audio.length, 1, "the caller's first words are not lost");
  assert.equal(
    bufferToInt16(Buffer.from(audio[0].realtimeInput.audio.data, 'base64')).length,
    8000
  );
  assert.equal(live.stats().preReadySamples, 0);
});

test('the pre-ready buffer is bounded — a slow brain cannot grow it forever', async (t) => {
  const ws = fakeWs({ autoSetup: false });
  const live = client(ws);
  t.after(() => live.close());
  await new Promise((r) => setTimeout(r, 5));

  for (let i = 0; i < 40; i += 1) live.sendAudioChunk(new Int16Array(1600)); // 4 s
  assert.ok(
    live.stats().preReadySamples <= PRE_READY_MAX_SAMPLES,
    `held ${live.stats().preReadySamples} samples`
  );

  ws.deliver({ setupComplete: {} });
  await live.ready;
  const held = bufferToInt16(
    Buffer.from(ws.frames('realtimeInput')[0].realtimeInput.audio.data, 'base64')
  ).length;
  assert.ok(held <= PRE_READY_MAX_SAMPLES && held > 0, 'the TAIL is kept — the most recent words');
});

test('sendText produces a completed clientContent turn (how we dictate a script)', async (t) => {
  const ws = fakeWs();
  const live = client(ws);
  t.after(() => live.close());
  await live.ready;

  live.sendText('SAY EXACTLY: call 190');
  const [f] = ws.frames('clientContent');
  assert.deepEqual(f.clientContent, {
    turns: [{ role: 'user', parts: [{ text: 'SAY EXACTLY: call 190' }] }],
    turnComplete: true,
  });
  assert.equal(live.sendText(''), false, 'an empty instruction is not sent');
});

test('sendToolResponse wraps a bare result and preserves an explicit response', async (t) => {
  const ws = fakeWs();
  const live = client(ws);
  t.after(() => live.close());
  await live.ready;

  live.sendToolResponse([{ id: 'c1', name: 'confirm_booking', result: { ok: true, ref: 'CE-1' } }]);
  live.sendToolResponse([{ id: 'c2', name: 'stage_booking', response: { result: { ok: false } } }]);
  const frames = ws.frames('toolResponse');
  assert.deepEqual(frames[0].toolResponse.functionResponses, [
    { id: 'c1', name: 'confirm_booking', response: { result: { ok: true, ref: 'CE-1' } } },
  ]);
  assert.deepEqual(frames[1].toolResponse.functionResponses[0].response, { result: { ok: false } });
  assert.equal(live.sendToolResponse([]), false);
});

test('handleServerFrame dispatches every frame kind the protocol defines', () => {
  const ws = fakeWs({ autoOpen: false });
  const live = client(ws);
  const seen = record(live);

  live.handleServerFrame({
    serverContent: { inputTranscription: { text: 'عندي وجع' }, outputTranscription: { text: 'أهلا' } },
  });
  live.handleServerFrame(audioFrame(new Int16Array([1, 2, 3])));
  live.handleServerFrame({ toolCall: { functionCalls: [{ id: 'x', name: 'stage_booking', args: { name: 'Ali' } }] } });
  live.handleServerFrame({ toolCallCancellation: { ids: ['x'] } });
  live.handleServerFrame({ goAway: { timeLeft: '5s' } });
  live.handleServerFrame({ serverContent: { turnComplete: true, generationComplete: true } });
  live.handleServerFrame({ usageMetadata: { totalTokenCount: 7 } });

  const kinds = seen.map(([k]) => k);
  assert.deepEqual(kinds, [
    'inputTranscription',
    'outputTranscription',
    'audio',
    'toolCall',
    'toolCallCancellation',
    'goAway',
    'turnComplete',
    'generationComplete',
    'usage',
  ]);
  assert.equal(seen[0][1], 'عندي وجع');
  assert.deepEqual([...seen[2][1]], [1, 2, 3], 'inlineData base64 becomes PCM16');
  assert.deepEqual(seen[3][1], [{ id: 'x', name: 'stage_booking', args: { name: 'Ali' } }]);
  assert.deepEqual(seen[4][1], ['x']);
  live.close();
});

test('interrupted is emitted BEFORE audio in the same frame (barge-in ordering)', () => {
  const ws = fakeWs({ autoOpen: false });
  const live = client(ws);
  const seen = record(live);
  live.handleServerFrame({
    serverContent: {
      interrupted: true,
      modelTurn: { parts: [{ inlineData: { data: b64(new Int16Array([9])), mimeType: 'audio/pcm' } }] },
    },
  });
  // If these ever swap, the flush would throw away the NEW turn's first frame.
  assert.deepEqual(seen.map(([k]) => k), ['interrupted', 'audio']);
  live.close();
});

test('non-audio inline parts and empty audio are ignored', () => {
  const ws = fakeWs({ autoOpen: false });
  const live = client(ws);
  const seen = record(live);
  live.handleServerFrame({
    serverContent: {
      modelTurn: {
        parts: [
          { text: 'hello' },
          { inlineData: { data: 'AAA=', mimeType: 'image/png' } },
          { inlineData: { data: '', mimeType: 'audio/pcm' } },
        ],
      },
    },
  });
  assert.equal(seen.length, 0);
  live.close();
});

test('a Blob frame is parsed, and frames stay in order across the async hop', async (t) => {
  const ws = fakeWs();
  const live = client(ws);
  t.after(() => live.close());
  await live.ready;
  const seen = record(live);

  ws.deliverBlob({ serverContent: { inputTranscription: { text: 'first' } } });
  ws.deliver({ serverContent: { inputTranscription: { text: 'second' } } });
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(
    seen.filter(([k]) => k === 'inputTranscription').map(([, v]) => v),
    ['first', 'second'],
    'a Blob must not let the frame behind it overtake'
  );
});

test('a garbage frame becomes an error event, never an exception', async (t) => {
  const ws = fakeWs();
  const live = client(ws);
  t.after(() => live.close());
  await live.ready;
  const seen = record(live);

  ws.deliverRaw('{ not json');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.filter(([k]) => k === 'error').length, 1);

  // …and the client keeps working.
  ws.deliver({ serverContent: { outputTranscription: { text: 'still alive' } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen.some(([k, v]) => k === 'outputTranscription' && v === 'still alive'));
});

test('a throwing handler cannot break the dispatcher', () => {
  const ws = fakeWs({ autoOpen: false });
  const live = client(ws);
  const ok = [];
  live.on('inputTranscription', () => {
    throw new Error('consumer bug');
  });
  live.on('inputTranscription', (t2) => ok.push(t2));
  live.handleServerFrame({ serverContent: { inputTranscription: { text: 'x' } } });
  assert.deepEqual(ok, ['x'], 'the second subscriber still ran');
  live.close();
});

test('handleServerFrame tolerates junk objects', () => {
  const ws = fakeWs({ autoOpen: false });
  const live = client(ws);
  for (const junk of [null, undefined, 42, 'str', {}, { serverContent: null }, { toolCall: {} }]) {
    live.handleServerFrame(junk);
  }
  live.close();
});

test('frames that land AFTER close are dropped, not dispatched', async (t) => {
  // A WebSocket close is not instantaneous. Driving a stopped loop means a tool
  // call against a torn-down store, or a transcript entry written after the
  // conversation row was already persisted.
  const ws = fakeWs();
  const live = client(ws);
  t.after(() => live.close());
  await live.ready;
  const seen = record(live);

  live.close();
  live.handleServerFrame({ serverContent: { inputTranscription: { text: 'ghost' } } });
  live.handleServerFrame({ toolCall: { functionCalls: [{ id: 'z', name: 'confirm_booking', args: {} }] } });
  assert.deepEqual(seen.filter(([k]) => k !== 'close'), []);
});

test('close() is idempotent, drops the socket, and stops sending', async (t) => {
  const ws = fakeWs();
  const live = client(ws);
  await live.ready;
  const before = ws.state.sent.length;

  live.close();
  live.close();
  assert.equal(ws.state.closed, 1, 'the underlying socket is closed exactly once');
  assert.equal(live.isReady, false);
  live.sendText('too late');
  live.sendAudioChunk(new Int16Array(4000));
  assert.equal(ws.state.sent.length, before, 'nothing is written after close');
  t.after(() => {});
});

test('the API key rides in the query string and nowhere else', async (t) => {
  const ws = fakeWs();
  const live = createLiveClient({ apiKey: 'k#ey/1', model: 'm', wsFactory: ws, readyTimeoutMs: 50 });
  t.after(() => live.close());
  assert.match(ws.state.url, /^wss:\/\/generativelanguage\.googleapis\.com\/ws\//);
  assert.match(ws.state.url, /\?key=k%23ey%2F1$/, 'url-encoded, exactly once');
  await live.ready;
  // The setup frame must never repeat the credential.
  assert.ok(!JSON.stringify(ws.state.sent).includes('k#ey'));
});

test('a wsFactory that throws fails `ready` instead of the composing caller', async () => {
  const live = createLiveClient({
    apiKey: '',
    model: 'm',
    wsFactory: () => {
      throw new Error('no socket for you');
    },
  });
  await assert.rejects(live.ready, /no socket/);
  live.close(); // must not throw either
});

test('HERMETICITY: the default factory is never reached when one is injected', () => {
  // Belt and braces on the repo law. If this ever regresses, a unit test would
  // dial Google from CI with whatever key happens to be in the environment.
  let built = 0;
  const ws = fakeWs({ autoOpen: false, autoSetup: false });
  const spy = (url) => {
    built += 1;
    return ws(url);
  };
  const live = createLiveClient({ apiKey: '', model: 'm', wsFactory: spy, readyTimeoutMs: 10 });
  assert.equal(built, 1);
  live.close();
});
