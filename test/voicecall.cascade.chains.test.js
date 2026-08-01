// V7-P1 — THE EARS AND THE BRAIN, as chains.
//
// Two failure modes decide whether the cascade is shippable, and neither is
// about the happy path:
//   • a vendor that will not connect must cost the caller ONE failover, not the
//     call;
//   • a free-tier 429 must move the turn to the NEXT provider, never silently
//     downgrade the product to the scripted engine — that silent downgrade is
//     the documented root cause of the founder's "bad replies" verdict.
//
// HERMETICITY LAW OF THIS REPO: no test opens a socket, of any kind, ever.
// Every WebSocket here is an injected fake and every fetch is an injected
// function; there is a test at the bottom proving a developer's real
// DEEPGRAM_API_KEY / CEREBRAS_API_KEY in .env cannot flip a test app onto a
// paid vendor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from '../test-helpers/client.js';
import { createSttChain, availableStt, STT_ORDER } from '../src/voice-call/brain-cascade/stt/index.js';
import {
  createDeepgramStt,
  buildDeepgramUrl,
  DEEPGRAM_LANGS,
  DEEPGRAM_MODEL,
} from '../src/voice-call/brain-cascade/stt/deepgram.js';
import {
  createSpeechmaticsStt,
  buildSpeechmaticsUrl,
} from '../src/voice-call/brain-cascade/stt/speechmatics.js';
import { createLiveEarsStt } from '../src/voice-call/brain-cascade/stt/liveEars.js';
import {
  createLlmChain,
  availableLlm,
  resetLlmBreakers,
  llmBreakerStats,
} from '../src/voice-call/brain-cascade/llm/index.js';
import { createGeminiTextLlm, toGeminiContents } from '../src/voice-call/brain-cascade/llm/geminiText.js';
import {
  createOpenAiCompatLlm,
  toOpenAiMessages,
} from '../src/voice-call/brain-cascade/llm/openaiCompat.js';
import { createClassicLlm, toSpoken } from '../src/voice-call/brain-cascade/llm/classic.js';
import { toOpenAiTools, toGeminiTools, toJsonSchema, parseToolArguments } from '../src/voice-call/brain-cascade/llm/tools.js';
import { buildToolDeclarations } from '../src/voice-call/brain/tools.js';
import { LlmError, isRotatable } from '../src/voice-call/brain-cascade/llm/http.js';

const CLINIC = 'el-amen-sousse';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(5);

// ── fakes ───────────────────────────────────────────────────────────────────

/** A WebSocket-shaped object the TEST drives. Never touches a socket. */
function fakeWs() {
  const ws = {
    url: null,
    protocols: null,
    headers: null,
    sent: [],
    closed: 0,
    send(data) {
      ws.sent.push(data);
    },
    close() {
      ws.closed += 1;
      ws.onclose?.({ code: 1000, reason: 'local' });
    },
    /** Test drivers. */
    open() {
      ws.onopen?.({});
    },
    message(obj) {
      ws.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
    },
    die(code = 1006, reason = 'gone') {
      ws.onclose?.({ code, reason });
    },
  };
  return ws;
}

function recordingWsFactory() {
  const made = [];
  const factory = (url, opts = {}) => {
    const ws = fakeWs();
    ws.url = url;
    ws.protocols = opts.protocols || null;
    ws.headers = opts.headers || null;
    made.push(ws);
    return ws;
  };
  factory.made = made;
  return factory;
}

/** A Gemini Live client the test drives — the same shape brain/loop's tests use. */
function fakeLive() {
  const handlers = new Map();
  const api = {
    opts: null,
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
    sendText() {
      return true;
    },
    sendToolResponse() {
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

/** An SSE body, cut into arbitrary chunks — including mid-line, on purpose. */
function sseBody(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  const reader = {
    cancelled: 0,
    async read() {
      if (i < chunks.length) {
        const value = enc.encode(chunks[i]);
        i += 1;
        return { value, done: false };
      }
      return { value: undefined, done: true };
    },
    cancel() {
      reader.cancelled += 1;
    },
  };
  return { getReader: () => reader, reader };
}

const sseFrame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, init, headers: init.headers || {}, body: init.body, signal: init.signal };
    calls.push(call);
    return handler ? await handler(call, calls.length) : { status: 200, body: sseBody([]) };
  };
  fn.calls = calls;
  return fn;
}

function spyLog() {
  const lines = [];
  const log = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  log.lines = lines;
  return log;
}

const collectEvents = (chain) => {
  const out = [];
  for (const ev of ['interim', 'final', 'lost', 'error']) chain.on(ev, (p) => out.push({ ev, p }));
  return out;
};

// ════════════════════════════════════════════════════════════════════════════
// 1. THE EARS
// ════════════════════════════════════════════════════════════════════════════

test('deepgram: the exact URL, the Tunisian language code, and both auth forms', async () => {
  const ws = recordingWsFactory();
  const stt = createDeepgramStt({ apiKey: 'dg-key', lang: 'ar', wsFactory: ws, logger: spyLog() });
  const [sock] = ws.made;

  assert.match(sock.url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  const q = new URL(sock.url).searchParams;
  assert.equal(q.get('model'), DEEPGRAM_MODEL);
  assert.equal(q.get('language'), 'ar-TN', 'the only explicit Tunisian code any vendor publishes');
  assert.equal(q.get('interim_results'), 'true');
  assert.equal(q.get('endpointing'), '300', 'the 250-400ms band the whole latency thesis rests on');
  assert.equal(q.get('encoding'), 'linear16');
  assert.equal(q.get('sample_rate'), '16000');
  // Node 22's global WebSocket takes subprotocols and no headers; an injected
  // `ws` takes the header. Both are handed over, deliberately.
  assert.deepEqual(sock.protocols, ['token', 'dg-key']);
  assert.equal(sock.headers.Authorization, 'Token dg-key');
  assert.equal(DEEPGRAM_LANGS.fr, 'fr');
  assert.match(buildDeepgramUrl({ lang: 'en' }), /language=en-US/);

  sock.open();
  assert.equal(await stt.ready, true, 'deepgram is ready on open — there is no hello frame to wait for');
  stt.close();
});

test('deepgram: interims, finals and speech_final are distinguished — endOfTurn is the fast path', async () => {
  const ws = recordingWsFactory();
  const stt = createDeepgramStt({ apiKey: 'k', wsFactory: ws, logger: spyLog() });
  const [sock] = ws.made;
  const seen = [];
  stt.on('interim', (e) => seen.push(['interim', e.text, e.endOfTurn]));
  stt.on('final', (e) => seen.push(['final', e.text, e.endOfTurn]));
  sock.open();

  sock.message({ type: 'Results', channel: { alternatives: [{ transcript: 'نحب نحجز' }] }, is_final: false });
  sock.message({ type: 'Results', channel: { alternatives: [{ transcript: 'نحب نحجز موعد' }] }, is_final: true, speech_final: false });
  sock.message({ type: 'Results', channel: { alternatives: [{ transcript: 'موعد قلب' }] }, is_final: true, speech_final: true });
  sock.message({ type: 'Results', channel: { alternatives: [{ transcript: '   ' }] }, is_final: true });
  sock.message({ type: 'Metadata', request_id: 'x' });
  await tick();

  assert.deepEqual(seen, [
    ['interim', 'نحب نحجز', undefined],
    ['final', 'نحب نحجز موعد', false],
    ['final', 'موعد قلب', true],
  ]);

  // Audio goes out as raw little-endian PCM16 bytes.
  stt.sendAudio(new Int16Array([1, -1]));
  const audio = sock.sent.at(-1);
  assert.ok(Buffer.isBuffer(audio) && audio.length === 4, 'PCM16LE, two bytes a sample');

  stt.close();
  assert.match(String(sock.sent.at(-1)), /CloseStream/, 'the tail is flushed — the end of a call is where bookings are');
});

/** The two-step Speechmatics auth: a fake mint endpoint issuing a short JWT. */
function fakeMintFetch(jwt = 'jwt-test') {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return { status: 200, json: async () => ({ key_value: jwt }) };
  };
  fn.calls = calls;
  return fn;
}

test('speechmatics: StartRecognition gates ready, and a final never claims end of turn', async () => {
  const ws = recordingWsFactory();
  const mint = fakeMintFetch('jwt-abc');
  const stt = createSpeechmaticsStt({
    apiKey: 'sm-key',
    lang: 'ar',
    wsFactory: ws,
    fetchImpl: mint,
    logger: spyLog(),
  });
  // The socket only exists AFTER the JWT mint resolves — that is the review
  // fix: the long-lived API key never rides the WebSocket URL.
  await tick();
  const [sock] = ws.made;
  assert.ok(sock, 'the socket is created once the mint resolves');
  assert.equal(sock.url, buildSpeechmaticsUrl('jwt-abc'));
  assert.ok(!sock.url.includes('sm-key'), 'the API key NEVER appears on the URL');
  assert.equal(mint.calls.length, 1);
  assert.match(mint.calls[0].url, /mp\.speechmatics\.com\/v1\/api_keys\?type=rt/);
  assert.equal(mint.calls[0].init.headers.Authorization, 'Bearer sm-key');

  const seen = [];
  stt.on('interim', (e) => seen.push(['interim', e.text]));
  stt.on('final', (e) => seen.push(['final', e.text, e.endOfTurn]));

  sock.open();
  const start = JSON.parse(sock.sent[0]);
  assert.equal(start.message, 'StartRecognition');
  assert.equal(start.audio_format.encoding, 'pcm_s16le');
  assert.equal(start.audio_format.sample_rate, 16000);
  assert.equal(start.transcription_config.enable_partials, true);
  assert.equal(start.transcription_config.language, 'ar');

  let ready = false;
  stt.ready.then(() => {
    ready = true;
  });
  await tick();
  assert.equal(ready, false, 'not ready until the vendor says RecognitionStarted');

  sock.message({ message: 'RecognitionStarted', id: 'x' });
  await tick();
  assert.equal(ready, true);

  sock.message({ message: 'AddPartialTranscript', metadata: { transcript: 'نحب' } });
  sock.message({ message: 'AddTranscript', metadata: { transcript: 'نحب نحجز موعد' } });
  await tick();
  assert.deepEqual(seen, [
    ['interim', 'نحب'],
    // No speech_final equivalent exists on this vendor: the end-of-turn call
    // belongs entirely to the orchestrator's timer, which is what it is for.
    ['final', 'نحب نحجز موعد', false],
  ]);
  stt.close();
});

test('liveEars: a Live session used ONLY as ears — its own audio is swallowed, never forwarded', async () => {
  const live = fakeLive();
  const stt = createLiveEarsStt({
    config: { geminiApiKey: 'g', geminiLiveModel: 'm' },
    liveFactory: (opts) => {
      live.opts = opts;
      live.setupComplete();
      return live;
    },
    logger: spyLog(),
  });
  const seen = [];
  stt.on('interim', (e) => seen.push(['interim', e.text]));
  stt.on('final', (e) => seen.push(['final', e.text, e.endOfTurn]));
  await stt.ready;

  // It is given NO tools: this session must not be able to cause a write.
  assert.deepEqual(live.opts.tools, []);
  assert.match(live.opts.systemInstruction, /silent transcription/i);

  live.emit('inputTranscription', 'عندي ');
  live.emit('inputTranscription', 'سؤال');
  // The model answers anyway — because a system instruction is a request, not a
  // control. Structurally, nothing forwards it.
  live.emit('audio', new Int16Array([1, 2, 3]));
  live.emit('text', 'أهلا');
  live.emit('turnComplete', true);
  await tick();

  assert.deepEqual(seen, [
    ['interim', 'عندي '],
    ['interim', 'عندي سؤال'],
    ['final', 'عندي سؤال', true],
  ]);
  assert.equal(stt.stats().swallowed, 2, 'its audio and its text are counted and dropped');

  stt.sendAudio(new Int16Array([5, 6]));
  assert.equal(live.audioChunks.length, 1);
  stt.close();
  assert.equal(live.closed, 1);
});

test('the STT chain fails over deepgram → speechmatics → liveEars, one warning each', async () => {
  const ws = recordingWsFactory();
  const live = fakeLive();
  const log = spyLog();
  const chain = createSttChain({
    config: { deepgramApiKey: 'dg', speechmaticsApiKey: 'sm', geminiApiKey: 'g', geminiLiveModel: 'm' },
    lang: 'ar',
    wsFactory: ws,
    fetchImpl: fakeMintFetch(), // the speechmatics leg mints its JWT over HTTP
    liveFactory: (opts) => {
      live.opts = opts;
      return live;
    },
    logger: log,
  });
  assert.deepEqual(chain.stats().order, ['deepgram', 'speechmatics', 'liveEars']);
  assert.equal(chain.provider, 'deepgram');

  // Audio that arrives before ANY leg is up is held, not dropped: the first two
  // seconds of a call are usually the caller saying "allo?".
  chain.sendAudio(new Int16Array(160));
  assert.equal(chain.stats().preReadySamples, 160);

  ws.made[0].die(1006, 'refused');
  await tick();
  assert.equal(chain.provider, 'speechmatics');
  assert.equal(ws.made.length, 2);

  ws.made[1].die(1006, 'refused');
  await tick();
  assert.equal(chain.provider, 'liveEars');
  live.setupComplete();
  await tick();

  // The held audio reaches the leg that actually came up.
  assert.equal(live.audioChunks.length, 1);
  assert.equal(chain.stats().preReadySamples, 0);
  assert.equal(chain.stats().failovers, 2);
  assert.equal(log.lines.filter((l) => /failing over/.test(l)).length, 2, 'one line per failure, not one per frame');

  // Only the LIVE leg's transcripts reach the orchestrator — a dying socket
  // that emits on its way out must not answer the caller twice.
  const seen = collectEvents(chain);
  live.emit('inputTranscription', 'سلام');
  live.emit('turnComplete', true);
  await tick();
  assert.deepEqual(seen.map((e) => e.ev), ['interim', 'final']);
  chain.close();
});

test('a chain with no adapters at all says LOST rather than pretending to listen', async () => {
  const log = spyLog();
  const chain = createSttChain({ config: {}, logger: log });
  const seen = collectEvents(chain);
  assert.deepEqual(availableStt({}), []);
  assert.equal(await chain.ready, null);
  assert.equal(chain.provider, null);
  await tick();
  assert.equal(seen.filter((e) => e.ev === 'lost').length, 1);
  assert.match(log.lines.join('\n'), /degrades to the WhatsApp thread/);
  // …and it still never throws into the RTP path.
  chain.sendAudio(new Int16Array(16));
  chain.close();
  chain.close();
});

test('availableStt reports exactly what the keys allow, in doctrine order', () => {
  assert.deepEqual(availableStt({ geminiApiKey: 'g' }), ['liveEars']);
  assert.deepEqual(availableStt({ speechmaticsApiKey: 's', geminiApiKey: 'g' }), ['speechmatics', 'liveEars']);
  assert.deepEqual(availableStt({ deepgramApiKey: 'd', speechmaticsApiKey: 's', geminiApiKey: 'g' }), [...STT_ORDER]);
  // An injected factory is how the suite exercises liveEars with no key at all.
  assert.deepEqual(availableStt({}, { liveFactory: () => {} }), ['liveEars']);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE TOOL TRANSLATOR — one list, three wire formats
// ════════════════════════════════════════════════════════════════════════════

test('the SAME declarations reach Gemini and OpenAI — translated, never forked', () => {
  const clinic = { id: 'x', specialties: [{ id: 'cardiology' }] };
  const decls = buildToolDeclarations({ clinic });
  const gemini = toGeminiTools(decls);
  assert.equal(gemini.length, 1);
  assert.deepEqual(
    gemini[0].functionDeclarations.map((d) => d.name),
    ['get_available_slots', 'stage_booking', 'confirm_booking', 'request_handoff', 'end_call']
  );

  const openai = toOpenAiTools(decls);
  assert.deepEqual(
    openai.map((t) => t.function.name),
    ['get_available_slots', 'stage_booking', 'confirm_booking', 'request_handoff', 'end_call']
  );
  const stage = openai.find((t) => t.function.name === 'stage_booking').function;
  assert.equal(stage.parameters.type, 'object', 'JSON Schema is lower case; the Gemini subset is not');
  assert.equal(stage.parameters.properties.datetimeText.type, 'string');
  assert.deepEqual(stage.parameters.required, ['datetimeText', 'name'], 'required survives the translation');
  // A tool with no parameters STILL needs a schema — several vendors 400 on a
  // missing one, and end_call is exactly that tool.
  const end = openai.find((t) => t.function.name === 'end_call').function;
  assert.deepEqual(end.parameters, { type: 'object', properties: {} });

  // A facilitator's list is shorter — and it must stay shorter through the
  // translator, or a rotation could hand an agency a booking tool.
  const agency = toOpenAiTools(buildToolDeclarations({ clinic: { id: 'a', type: 'facilitator' } }));
  assert.deepEqual(agency.map((t) => t.function.name), ['capture_lead', 'request_handoff', 'end_call']);

  assert.deepEqual(toJsonSchema({ type: 'ARRAY', items: { type: 'STRING' } }), {
    type: 'array',
    items: { type: 'string' },
  });
  assert.equal(toOpenAiTools([]), undefined);
  assert.equal(toGeminiTools(null), undefined);
});

test('streamed tool arguments that arrive malformed become {} rather than a throw', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments('{"a":'), {}, 'a half-streamed argument is not a crash');
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments('[1,2]'), {}, 'an array is not an argument object');
  assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
});

test('history translates to both dialects, including tool results', () => {
  const history = [
    { role: 'user', text: 'نحب نحجز' },
    { role: 'assistant', text: 'ثانية برك', toolCalls: [{ id: 'c1', name: 'stage_booking', args: { name: 'X' } }] },
    { role: 'tool', callId: 'c1', name: 'stage_booking', result: { ok: true } },
  ];
  const contents = toGeminiContents(history);
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[1].role, 'model');
  assert.equal(contents[1].parts[1].functionCall.name, 'stage_booking');
  assert.equal(contents[2].parts[0].functionResponse.response.result.ok, true);

  const msgs = toOpenAiMessages('SYSTEM', history);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[2].tool_calls[0].function.name, 'stage_booking');
  assert.equal(JSON.parse(msgs[2].tool_calls[0].function.arguments).name, 'X');
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[3].tool_call_id, 'c1');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE BRAIN — providers and rotation
// ════════════════════════════════════════════════════════════════════════════

test('gemini text: thinkingLevel (never thinkingBudget), SSE parsed, thoughts skipped', async () => {
  const fetchImpl = recordingFetch(() => ({
    status: 200,
    body: sseBody([
      // A frame split across two network reads — this happens more often than
      // anyone expects, and a naive line reader loses the turn.
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'أهلا ' }] } }] })}`,
      '\n\n',
      sseFrame({ candidates: [{ content: { parts: [{ text: 'برك', thought: true }] } }] }),
      sseFrame({ candidates: [{ content: { parts: [{ text: 'بيك.' }] } }] }),
      sseFrame({
        candidates: [{ content: { parts: [{ functionCall: { name: 'end_call', args: {} } }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8 },
      }),
      'data: [DONE]\n\n',
    ]),
  }));
  const llm = createGeminiTextLlm({ apiKey: 'gk', tools: [], fetchImpl, logger: spyLog() });
  const out = [];
  for await (const ev of llm.stream({ system: 'SYS', messages: [{ role: 'user', text: 'عسلامة' }] })) out.push(ev);

  const [call] = fetchImpl.calls;
  assert.match(call.url, /gemini-flash-lite-latest:streamGenerateContent\?alt=sse&key=gk$/);
  const body = JSON.parse(call.body);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  assert.equal(body.generationConfig.thinkingBudget, undefined, 'thinkingBudget:0 is a 400 on 3.x — never send it');
  assert.equal(body.systemInstruction.parts[0].text, 'SYS');

  assert.deepEqual(
    out.filter((e) => e.type === 'text').map((e) => e.delta),
    ['أهلا ', 'بيك.'],
    'a thought part is never spoken out loud'
  );
  assert.equal(out.find((e) => e.type === 'toolCall').call.name, 'end_call');
  assert.deepEqual(out.at(-1), { type: 'done', usage: { tokensIn: 120, tokensOut: 8 } });
});

test('gemini text: a 429 is a QUOTA error, and quota is what rotates the chain', async () => {
  const fetchImpl = recordingFetch(() => ({ status: 429, text: async () => 'RESOURCE_EXHAUSTED' }));
  const llm = createGeminiTextLlm({ apiKey: 'k', fetchImpl, logger: spyLog() });
  await assert.rejects(
    (async () => {
      for await (const _ of llm.stream({ messages: [{ role: 'user', text: 'x' }] })) void _;
    })(),
    (err) => {
      assert.equal(err.name, 'LlmError');
      assert.equal(err.kind, 'quota');
      assert.equal(err.status, 429);
      assert.equal(isRotatable(err), true);
      return true;
    }
  );
  assert.equal(isRotatable(new LlmError('bad request', { status: 400, kind: 'http' })), false);
});

test('an OpenAI-compatible vendor: tool-call fragments are accumulated, never half-parsed', async () => {
  const fetchImpl = recordingFetch((call) => {
    if (call.url.endsWith('/models')) {
      return { status: 200, json: async () => ({ data: [{ id: 'llama-3.3-70b' }] }) };
    }
    return {
      status: 200,
      body: sseBody([
        sseFrame({ choices: [{ delta: { content: 'ثانية ' } }] }),
        sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'stage_booking' } }] } }] }),
        sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"name":' } }] } }] }),
        sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"محمد"}' } }] } }] }),
        sseFrame({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 5 } }),
      ]),
    };
  });
  const llm = createOpenAiCompatLlm({ provider: 'cerebras', apiKey: 'ck', tools: [], fetchImpl, logger: spyLog() });
  const out = [];
  for await (const ev of llm.stream({ system: 'S', messages: [{ role: 'user', text: 'hi' }] })) out.push(ev);

  assert.equal(fetchImpl.calls[0].url, 'https://api.cerebras.ai/v1/models', 'the model id is verified at runtime');
  assert.equal(fetchImpl.calls[1].url, 'https://api.cerebras.ai/v1/chat/completions');
  const body = JSON.parse(fetchImpl.calls[1].body);
  assert.equal(body.model, 'llama-3.3-70b');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });

  const call = out.find((e) => e.type === 'toolCall').call;
  assert.equal(call.name, 'stage_booking');
  assert.deepEqual(call.args, { name: 'محمد' }, 'the arguments are only parsed once they are whole');
  assert.deepEqual(out.at(-1).usage, { tokensIn: 30, tokensOut: 5 });
});

test('a vendor that renamed its free model is followed, not failed', async () => {
  const fetchImpl = recordingFetch((call) => {
    if (call.url.endsWith('/models')) {
      return { status: 200, json: async () => ({ data: [{ id: 'llama-3.3-70b-versatile-2026' }] }) };
    }
    return { status: 200, body: sseBody([sseFrame({ choices: [{ delta: { content: 'ok' } }] })]) };
  });
  const log = spyLog();
  const llm = createOpenAiCompatLlm({ provider: 'groq', apiKey: 'gk', fetchImpl, logger: log });
  for await (const _ of llm.stream({ messages: [{ role: 'user', text: 'x' }] })) void _;
  assert.equal(JSON.parse(fetchImpl.calls[1].body).model, 'llama-3.3-70b-versatile-2026');
  assert.match(log.lines.join('\n'), /does not list/);
});

test('THE ROTATION: flash-lite 429s, 3-flash answers, and the chain NAMES who answered', async () => {
  resetLlmBreakers();
  const fetchImpl = recordingFetch((call) => {
    if (call.url.includes('gemini-flash-lite-latest')) return { status: 429, text: async () => 'quota' };
    return {
      status: 200,
      body: sseBody([
        sseFrame({ candidates: [{ content: { parts: [{ text: 'عندي بلاصة الخميس.' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } }),
      ]),
    };
  });
  const log = spyLog();
  const chain = createLlmChain({
    config: { geminiApiKey: 'k' },
    clinic: { id: CLINIC },
    tools: [],
    fetchImpl,
    logger: log,
  });
  assert.deepEqual(chain.order, ['gemini-flash-lite-latest', 'gemini-3-flash-preview', 'classic']);

  const out = [];
  for await (const ev of chain.streamTurn({ system: 'S', messages: [{ role: 'user', text: 'وقتاش فمة بلاصة؟' }] })) {
    out.push(ev);
  }
  assert.deepEqual(out.filter((e) => e.type === 'text').map((e) => e.delta), ['عندي بلاصة الخميس.']);
  assert.equal(out.at(-1).provider, 'gemini-3-flash-preview', 'the waterfall can name the model that answered');
  assert.equal(chain.provider, 'gemini-3-flash-preview');
  assert.match(log.lines.join('\n'), /rotating to gemini-3-flash-preview/);
  assert.equal(chain.stats().rotations, 1);
  resetLlmBreakers();
});

test('THE LAW: every remote provider down ⇒ CLASSIC speaks. Never silence, never a silent downgrade', async (t) => {
  resetLlmBreakers();
  const app = makeTestApp();
  const clinic = app.store.getClinicById(CLINIC);
  const fetchImpl = recordingFetch(() => ({ status: 503, text: async () => 'high demand' }));
  const log = spyLog();
  const chain = createLlmChain({
    config: { geminiApiKey: 'k' },
    clinic,
    store: app.store,
    tools: [],
    lang: 'ar',
    patientWaId: '218911234567',
    fetchImpl,
    logger: log,
  });

  const out = [];
  for await (const ev of chain.streamTurn({ system: 'S', messages: [{ role: 'user', text: 'نحب نحجز موعد' }] })) {
    out.push(ev);
  }
  const said = out.filter((e) => e.type === 'text').map((e) => e.delta).join(' ');
  assert.ok(said.trim().length > 0, 'the caller hears SOMETHING — silence is the one outcome this forbids');
  assert.equal(out.at(-1).provider, 'classic');
  // …and the degradation is LOUD. This is the whole fix for "bad replies":
  // a downgrade nobody can see is a downgrade nobody fixes.
  assert.equal(log.lines.filter((l) => /rotating to/.test(l)).length, 2);
  assert.equal(chain.stats().byProvider.classic, 1);

  // A booking the chat flow writes still shows up on the CALL's outcome.
  const seen = [];
  const withResult = createLlmChain({
    config: {},
    clinic,
    store: app.store,
    lang: 'ar',
    patientWaId: '218911234567',
    logger: spyLog(),
    onClassicResult: (r) => seen.push(r),
  });
  for await (const _ of withResult.streamTurn({ messages: [{ role: 'user', text: 'عسلامة' }] })) void _;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].clinicId, CLINIC);
  resetLlmBreakers();
});

test('the classic link speaks CHAT copy out loud without the emoji and the bullets', () => {
  assert.equal(toSpoken('👋 أهلاً بيك\n• حجز موعد\n• الأسعار'), 'أهلاً بيك. حجز موعد. الأسعار');
  assert.equal(toSpoken('**نعم** 1️⃣ باهي'), 'نعم باهي');
  assert.equal(toSpoken(''), '');
});

test('the LLM breaker benches a provider after repeated failures, then probes once', async () => {
  resetLlmBreakers();
  let calls = 0;
  const fetchImpl = recordingFetch((call) => {
    if (call.url.includes('flash-lite')) {
      calls += 1;
      return { status: 429, text: async () => 'quota' };
    }
    return { status: 200, body: sseBody([sseFrame({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })]) };
  });
  const chain = createLlmChain({ config: { geminiApiKey: 'k' }, clinic: { id: 'x' }, fetchImpl, logger: spyLog() });

  for (let i = 0; i < 3; i += 1) {
    for await (const _ of chain.streamTurn({ messages: [{ role: 'user', text: 'x' }] })) void _;
  }
  // Two failures open it; the third turn skips flash-lite entirely rather than
  // paying ~600 ms to rediscover a quota wall that recovers in ~20 s.
  assert.equal(calls, 2, 'the benched provider is not called again inside the cooldown');
  const stats = llmBreakerStats().find((s) => s.provider === 'gemini-flash-lite-latest');
  assert.equal(stats.open, true);
  resetLlmBreakers();
});

test('availableLlm always ends in classic — something has to answer the phone', () => {
  assert.deepEqual(availableLlm({}), ['classic']);
  assert.deepEqual(availableLlm({ geminiApiKey: 'g' }), [
    'gemini-flash-lite-latest',
    'gemini-3-flash-preview',
    'classic',
  ]);
  assert.deepEqual(availableLlm({ cerebrasApiKey: 'c', groqApiKey: 'q' }), ['cerebras', 'groq', 'classic']);
});

test('HERMETICITY: a developer .env STT/LLM key can never flip a test app onto a vendor', () => {
  const saved = {
    b: process.env.VOICE_BRAIN,
    d: process.env.DEEPGRAM_API_KEY,
    s: process.env.SPEECHMATICS_API_KEY,
    c: process.env.CEREBRAS_API_KEY,
    g: process.env.GROQ_API_KEY,
    f: process.env.FISH_AUDIO_API,
  };
  process.env.VOICE_BRAIN = 'cascade';
  process.env.DEEPGRAM_API_KEY = 'a-real-key';
  process.env.SPEECHMATICS_API_KEY = 'a-real-key';
  process.env.CEREBRAS_API_KEY = 'a-real-key';
  process.env.GROQ_API_KEY = 'a-real-key';
  process.env.FISH_AUDIO_API = 'a-real-key';
  try {
    const app = makeTestApp();
    assert.equal(app.config.voiceBrain, 'live', 'the experimental brain is opt-in per suite, never per machine');
    assert.equal(app.config.deepgramApiKey, '');
    assert.equal(app.config.speechmaticsApiKey, '');
    assert.equal(app.config.cerebrasApiKey, '');
    assert.equal(app.config.groqApiKey, '');
    assert.equal(app.config.fishAudioApi, '');
    // The end that matters: composed from a test app's config, the chains reach
    // nobody. STT has no adapter at all and the brain is the offline engine.
    assert.deepEqual(availableStt(app.config), []);
    assert.deepEqual(availableLlm(app.config), ['classic']);
  } finally {
    for (const [k, v] of [
      ['VOICE_BRAIN', saved.b],
      ['DEEPGRAM_API_KEY', saved.d],
      ['SPEECHMATICS_API_KEY', saved.s],
      ['CEREBRAS_API_KEY', saved.c],
      ['GROQ_API_KEY', saved.g],
      ['FISH_AUDIO_API', saved.f],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
