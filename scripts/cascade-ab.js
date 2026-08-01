// V7-P2 — THE A/B HARNESS. Ten synthetic calls against a RUNNING local server,
// one brain per run, with the waterfalls read back off the call records.
//
// THIS IS NOT A TEST. It talks to the real app over real UDP and lets the app
// talk to whatever real providers its .env configures. `npm test` must never
// import it, and it is never run in CI.
//
// ── THE TWO-TERMINAL RECIPE ─────────────────────────────────────────────────
// VOICE_BRAIN is read once, at boot, by the process that answers the phone. One
// server process therefore has exactly ONE brain, and alternating per call is
// impossible without restarting it. So the A/B is two runs, compared afterwards
// from the rows this script appends to docs/V7-AB-RESULTS.md:
//
//   # terminal 1 — the app, on the CASCADE:
//   VOICE_BRAIN=cascade VOICE_CALL_MODE=brain WHATSAPP_TRANSPORT=mock \
//     VOICE_CALL_TRANSPORT=real VOICE_CALL_GRAPH_BASE=http://localhost:3902 npm start
//   # terminal 2:
//   node scripts/cascade-ab.js --mode cascade --calls 10
//
//   # then stop the app, restart it on the incumbent, and run the other side:
//   VOICE_BRAIN=live VOICE_CALL_MODE=brain WHATSAPP_TRANSPORT=mock \
//     VOICE_CALL_TRANSPORT=real VOICE_CALL_GRAPH_BASE=http://localhost:3902 npm start
//   node scripts/cascade-ab.js --mode live --calls 10
//
// `--mode` is a LABEL plus a safety check: every call record carries
// `brain.mode`, and this script shouts if the server answered on a different
// brain than the one the row claims. A mislabelled A/B is worse than no A/B.
//
// ── WHAT THIS MEASURES, AND WHAT IT DOES NOT ────────────────────────────────
// The synthetic caller sends a 440 Hz tone, not Derja. So this measures
// PLUMBING latency:
//
//   • connect_ms   — connect webhook posted → pre_accept came back (signaling)
//   • accept_ms    — connect webhook posted → accept came back
//   • greeting_ms  — accept → the FIRST audio packet the caller hears
//   • turn_ms      — our last uplink frame → the next agent audio packet
//
// Those four are the pipeline the founder's ear cannot separate from the model.
// The MODEL-side numbers — vad/stt/llm_ttft/tts_ttfb per turn — are not invented
// here: they are read back off the call record the server wrote, which is the
// same waterfall the per-turn '[voice-cascade] waterfall …' log line prints. A
// tone produces no words, so on a well-behaved STT leg a run may record zero
// turns; that is expected and is reported as `n/a` rather than faked. Real
// Derja turns are the founder's own live calls (P3), and this script exists so
// that the plumbing under them is a measured constant rather than a suspect.
//
// ── OPTIONS ─────────────────────────────────────────────────────────────────
//   --mode cascade|live   which brain the RUNNING server is on          (label)
//   --calls N             synthetic calls to place                      (10)
//   --app URL             the app's webhook base            (http://localhost:3000)
//   --graph-port N        the port this script serves "Meta Graph" on   (3902)
//   --pnid ID             tenant phone_number_id (must exist in clinics.json)
//   --from WAID           the synthetic caller's id
//   --talk-ms N           uplink tone per call, after the greeting      (2500)
//   --settle-ms N         quiet time waited for a reply before hanging up (6000)
//   --gap-ms N            pause between calls                           (1500)
//   --runtime DIR         where the app persists its JSON store   (data/runtime)
//   --email / --password  dashboard credentials; enables the GET /api/calls
//                         cross-check (optional — the store is the source)
//   --no-write            print the summary, do not touch docs/V7-AB-RESULTS.md
import express from 'express';
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodecBridge } from '../src/voice-call/brain/codec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_FILE = path.join(ROOT, 'docs', 'V7-AB-RESULTS.md');
const FRAME_MS = 20;
const TONE_RATE = 24000;

// ── argv ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key.startsWith('no-')) {
      out[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const MODE = String(args.mode || process.env.VOICE_BRAIN || 'live').toLowerCase();
const CALLS = Math.max(1, Number(args.calls) || 10);
const APP = String(args.app || process.env.AB_APP || 'http://localhost:3000').replace(/\/$/, '');
const APP_WEBHOOK = `${APP}/webhook`;
const GRAPH_PORT = Number(args['graph-port']) || 3902;
const PNID = String(args.pnid || process.env.AB_PNID || '1153135121224452');
const FROM = String(args.from || process.env.AB_FROM || '216AB000001');
const TALK_MS = Number(args['talk-ms']) || 2500;
const SETTLE_MS = Number(args['settle-ms']) || 6000;
const GAP_MS = Number(args['gap-ms']) || 1500;
const RUNTIME_DIR = path.resolve(String(args.runtime || process.env.AB_RUNTIME || path.join(ROOT, 'data', 'runtime')));
const EMAIL = args.email || process.env.AB_EMAIL || '';
const PASSWORD = args.password || process.env.AB_PASSWORD || '';
const WRITE = args.write !== false;

if (!['cascade', 'live'].includes(MODE)) {
  console.error(`--mode must be cascade|live (got ${JSON.stringify(MODE)})`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── stats ───────────────────────────────────────────────────────────────────
function percentile(values, p) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
const median = (v) => percentile(v, 0.5);
const fmt = (v) => (v == null ? 'n/a' : `${Math.round(v)}ms`);

// ── the "Meta Graph" side (call-harness.js, minus the browser) ───────────────
/** callId → { actions[], sdpAnswer, accepted, ended, at:{action:ms} } */
const calls = new Map();

function startGraph() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // Any version segment, exactly as the harness does, so bumping
  // WHATSAPP_GRAPH_VERSION can never silently 404 the A/B.
  app.post('/:version/:pnid/calls', (req, res) => {
    const { call_id: callId, action, session } = req.body || {};
    const c = calls.get(String(callId));
    if (c) {
      c.actions.push(action);
      c.at[action] = Date.now();
      if (session?.sdp && !c.sdpAnswer) c.sdpAnswer = session.sdp;
      if (action === 'accept') c.accepted = true;
      if (action === 'reject' || action === 'terminate') c.ended = action;
    }
    res.json({ success: true });
  });
  app.get('/health', (_req, res) => res.json({ ok: true, calls: calls.size }));
  return new Promise((resolve, reject) => {
    const server = app.listen(GRAPH_PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// ── the webhook bodies (Meta's exact shape) ─────────────────────────────────
function connectBody(callId, sdp) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'CASCADE-AB',
        changes: [
          {
            field: 'calls',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+216 73 000 111', phone_number_id: PNID },
              calls: [
                {
                  id: callId,
                  from: FROM,
                  to: PNID,
                  event: 'connect',
                  direction: 'USER_INITIATED',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  session: { sdp_type: 'offer', sdp },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function terminateBody(callId, startedAt) {
  const duration = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'CASCADE-AB',
        changes: [
          {
            field: 'calls',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+216 73 000 111', phone_number_id: PNID },
              calls: [
                {
                  id: callId,
                  from: FROM,
                  to: PNID,
                  event: 'terminate',
                  direction: 'USER_INITIATED',
                  status: 'Completed',
                  start_time: String(Math.floor(startedAt / 1000)),
                  end_time: String(Math.floor(Date.now() / 1000)),
                  duration,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r;
}

// ── the synthetic caller (in-process werift, no browser) ────────────────────
/** `ms` of 440 Hz at TONE_RATE — loud enough for a VAD, meaningless to an STT. */
function tone(ms) {
  const n = Math.round((TONE_RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / TONE_RATE));
  return out;
}

const rand32 = () => Math.floor(Math.random() * 0xffffffff) >>> 0;
const rand16 = () => Math.floor(Math.random() * 0xffff) & 0xffff;

/**
 * Place ONE call and measure it.
 * @returns {Promise<object>} the per-call row
 */
async function placeCall(n, werift) {
  const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } = werift;
  const callId = `wacid.AB-${MODE.toUpperCase()}-${Date.now()}-${n}`;
  const row = {
    n,
    callId,
    connectMs: null,
    acceptMs: null,
    greetingMs: null,
    turnMs: null,
    rtpIn: 0,
    error: null,
  };

  const pc = new RTCPeerConnection({
    // Empty ICE server list: both ends are on loopback, and depending on
    // outbound UDP to a public STUN server would make a latency measurement
    // hostage to the founder's Wi-Fi.
    iceServers: [],
    codecs: {
      audio: [
        new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }),
        new RTCRtpCodecParameters({ mimeType: 'audio/telephone-event', clockRate: 8000 }),
      ],
    },
  });
  const outTrack = new MediaStreamTrack({ kind: 'audio' });

  let firstInboundAt = 0;
  let lastInboundAt = 0;
  let uplinkEndedAt = 0;
  let replyAt = 0;
  // Subscribe BEFORE setRemoteDescription — werift fires onTrack synchronously
  // while applying the remote SDP (the lesson already written into media.js).
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe(() => {
      const at = Date.now();
      row.rtpIn += 1;
      if (!firstInboundAt) firstInboundAt = at;
      lastInboundAt = at;
      // The first agent audio AFTER we stopped talking is the reply. Anything
      // still arriving within one frame of our last uplink packet is the tail
      // of the greeting, not an answer.
      if (uplinkEndedAt && !replyAt && at - uplinkEndedAt > FRAME_MS) replyAt = at;
    });
  });

  const entry = { actions: [], sdpAnswer: null, accepted: false, ended: null, at: {} };
  calls.set(callId, entry);

  try {
    // BEFORE createOffer, always. An offer built without the track is recvonly,
    // the app answers a one-way path, no uplink RTP ever flows, media never
    // reaches 'connected' and the app never sends `accept` — which reads on
    // this side as "the app ignored the call". Same lesson the browser harness
    // encodes by adding its getUserMedia tracks first.
    pc.addTrack(outTrack);
    await pc.setLocalDescription(await pc.createOffer()); // resolves after ICE gathering
    const offer = pc.localDescription?.sdp;
    if (!offer) throw new Error('werift produced no local SDP');

    const startedAt = Date.now();
    const res = await post(APP_WEBHOOK, connectBody(callId, offer));
    if (!res.ok) throw new Error(`the app rejected the connect webhook (HTTP ${res.status})`);

    // pre_accept carries the answer; accept means the caller can hear us.
    const until = Date.now() + 25000;
    while (!entry.sdpAnswer && !entry.ended && Date.now() < until) await sleep(10);
    if (entry.ended === 'reject') {
      // The single most likely reason a founder's A/B produces nothing: the
      // clinic is CLOSED right now, so the app declines every call by design.
      const e = new Error(`the clinic DECLINED the call — outside ${PNID}'s working hours, or the wrong tenant`);
      e.fatal = true;
      throw e;
    }
    if (entry.ended) throw new Error(`the app ended the call before answering (${entry.ended})`);
    if (!entry.sdpAnswer) throw new Error('no pre_accept within 25s — is the app on VOICE_CALL_GRAPH_BASE?');
    row.connectMs = entry.at.pre_accept - startedAt;

    await pc.setRemoteDescription({ type: 'answer', sdp: entry.sdpAnswer });

    while (!entry.accepted && !entry.ended && Date.now() < until) await sleep(10);
    if (!entry.accepted) throw new Error('the app never accepted the call (ICE/DTLS never completed)');
    row.acceptMs = entry.at.accept - startedAt;
    const acceptedAt = entry.at.accept;

    // ── the greeting ────────────────────────────────────────────────────────
    const greetUntil = Date.now() + 15000;
    while (!firstInboundAt && Date.now() < greetUntil) await sleep(5);
    row.greetingMs = firstInboundAt ? firstInboundAt - acceptedAt : null;

    // Let the greeting finish before talking over it — a barge-in here would
    // measure the kill chain, not the turn.
    let quietUntil = Date.now() + 8000;
    while (Date.now() < quietUntil) {
      if (!firstInboundAt) break; // nothing was ever said — do not wait it out
      if (Date.now() - lastInboundAt > 400) break;
      await sleep(20);
    }

    // ── one uplink turn ─────────────────────────────────────────────────────
    const codec = createCodecBridge({ sdpOffer: offer, sdpAnswer: entry.sdpAnswer, logger: () => {} });
    const frames = codec.encodeOut(tone(TALK_MS), TONE_RATE);
    let seq = rand16();
    let ts = rand32();
    const ssrc = rand32();
    let mark = true;
    for (const payload of frames) {
      const header = Buffer.allocUnsafe(12);
      header[0] = 0x80;
      header[1] = (mark ? 0x80 : 0x00) | (codec.payloadType & 0x7f);
      header.writeUInt16BE(seq, 2);
      header.writeUInt32BE(ts >>> 0, 4);
      header.writeUInt32BE(ssrc >>> 0, 8);
      seq = (seq + 1) & 0xffff;
      ts = (ts + codec.timestampIncrement) >>> 0;
      mark = false;
      try {
        outTrack.writeRtp(Buffer.concat([header, payload]));
      } catch {
        /* a dropped uplink frame is not worth ending a measurement over */
      }
      await sleep(FRAME_MS);
    }
    uplinkEndedAt = Date.now();

    // ── the reply (if the STT heard anything in a sine wave) ────────────────
    quietUntil = Date.now() + SETTLE_MS;
    while (!replyAt && Date.now() < quietUntil) await sleep(10);
    row.turnMs = replyAt ? replyAt - uplinkEndedAt : null;

    await post(APP_WEBHOOK, terminateBody(callId, startedAt));
  } catch (err) {
    row.error = err?.message || String(err);
    row.fatal = !!err?.fatal;
    try {
      await post(APP_WEBHOOK, terminateBody(callId, Date.now()));
    } catch {
      /* best effort — the app's own watchdog closes the books either way */
    }
  } finally {
    try {
      outTrack.stop();
    } catch {
      /* best effort */
    }
    try {
      await Promise.resolve(pc.close()).catch(() => {});
    } catch {
      /* best effort */
    }
  }
  return row;
}

// ── reading the call records back ───────────────────────────────────────────
/**
 * The server persists synchronously (writeFileSync per mutation), so the row is
 * on disk by the time the terminate webhook has been answered. It is still read
 * with a short retry: the terminate response returns before finish() has
 * necessarily drained a tool call.
 */
async function readRecords(ids) {
  const file = path.join(RUNTIME_DIR, 'messages.json');
  const wanted = new Set(ids);
  const found = new Map();
  for (let attempt = 0; attempt < 20 && found.size < wanted.size; attempt += 1) {
    if (attempt) await sleep(250);
    if (!existsSync(file)) continue;
    let rows = [];
    try {
      rows = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // a half-written file: try again
    }
    for (const m of rows) {
      const call = m?.body?.call;
      if (call && wanted.has(call.callId)) found.set(call.callId, call);
    }
  }
  return found;
}

/** Optional cross-check: does the dashboard see the same calls? */
async function apiCrossCheck(ids) {
  if (!EMAIL || !PASSWORD) return null;
  try {
    const login = await fetch(`${APP}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!login.ok) return { error: `login failed (HTTP ${login.status})` };
    const raw = login.headers.getSetCookie?.() || [];
    const cookie = raw.map((c) => c.split(';')[0]).find((c) => c.startsWith('omen_session='));
    if (!cookie) return { error: 'no session cookie returned' };
    const r = await fetch(`${APP}/api/calls?limit=200`, { headers: { Cookie: cookie } });
    if (!r.ok) return { error: `GET /api/calls failed (HTTP ${r.status})` };
    const body = await r.json();
    const seen = new Set((body.calls || []).map((c) => c.callId));
    return { seen: ids.filter((id) => seen.has(id)).length, total: ids.length };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// ── output ──────────────────────────────────────────────────────────────────
function summarize(rows, records) {
  const ok = rows.filter((r) => !r.error);
  const waterfalls = [];
  const modes = new Set();
  const providers = new Set();
  let recTurns = 0;
  const recMedians = [];
  const recP95s = [];
  const greetingSources = [];
  const usage = { llmTokensIn: 0, llmTokensOut: 0, ttsChars: 0, ttsRequests: 0, sttMs: 0 };

  for (const r of rows) {
    const rec = records.get(r.callId);
    const brain = rec?.brain;
    if (!brain) continue;
    modes.add(brain.mode || 'unknown');
    if (brain.providers) {
      providers.add(`${brain.providers.stt || 'n/a'} → ${brain.providers.llm || 'n/a'} → ${brain.providers.tts || 'n/a'}`);
    }
    for (const w of brain.waterfalls || []) waterfalls.push(w);
    if (brain.latency) {
      recTurns += Number(brain.latency.turns) || 0;
      if (brain.latency.medianMs != null) recMedians.push(brain.latency.medianMs);
      if (brain.latency.p95Ms != null) recP95s.push(brain.latency.p95Ms);
      if (brain.latency.greetingSource) greetingSources.push(brain.latency.greetingSource);
    }
    for (const k of Object.keys(usage)) usage[k] += Number(brain.usage?.[k]) || 0;
  }

  const pick = (key) => waterfalls.map((w) => w[key]).filter((v) => Number.isFinite(v));
  return {
    placed: rows.length,
    ok: ok.length,
    failed: rows.length - ok.length,
    connect: { p50: median(ok.map((r) => r.connectMs)), p95: percentile(ok.map((r) => r.connectMs), 0.95) },
    accept: { p50: median(ok.map((r) => r.acceptMs)) },
    greeting: { p50: median(ok.map((r) => r.greetingMs)), p95: percentile(ok.map((r) => r.greetingMs), 0.95) },
    turn: { p50: median(ok.map((r) => r.turnMs)), p95: percentile(ok.map((r) => r.turnMs), 0.95) },
    records: records.size,
    modes: [...modes],
    providers: [...providers],
    recTurns,
    recMedian: median(recMedians),
    recP95: percentile(recP95s, 0.95),
    greetingSources: [...new Set(greetingSources)],
    usage,
    waterfall: {
      turns: waterfalls.length,
      vad: median(pick('vad_ms')),
      stt: median(pick('stt_final_ms')),
      llmTtft: median(pick('llm_ttft_ms')),
      ttsTtfb: median(pick('tts_ttfb_ms')),
      firstAudio: median(pick('first_audio_ms')),
      firstAudioP95: percentile(pick('first_audio_ms'), 0.95),
    },
  };
}

function printSummary(s, crossCheck) {
  const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
  console.log('');
  console.log(`════ V7 A/B — mode=${MODE} · ${s.ok}/${s.placed} calls completed ════`);
  console.log('');
  console.log('  PLUMBING (measured by this script, synthetic tone caller)');
  line('connect (pre_accept)', `p50 ${fmt(s.connect.p50)}  p95 ${fmt(s.connect.p95)}`);
  line('accept', `p50 ${fmt(s.accept.p50)}`);
  line('greeting (felt)', `p50 ${fmt(s.greeting.p50)}  p95 ${fmt(s.greeting.p95)}`);
  line('turn (felt)', `p50 ${fmt(s.turn.p50)}  p95 ${fmt(s.turn.p95)}`);
  console.log('');
  console.log(`  CALL RECORDS (${s.records}/${s.placed} found in ${path.relative(ROOT, RUNTIME_DIR)})`);
  line('brain.mode', s.modes.length ? s.modes.join(', ') : 'n/a');
  line('chain', s.providers.length ? s.providers.join(' | ') : 'n/a');
  line('greeting source', s.greetingSources.length ? s.greetingSources.join(', ') : 'n/a');
  line('recorded turns', String(s.recTurns));
  line('recorded turn latency', `p50 ${fmt(s.recMedian)}  p95 ${fmt(s.recP95)}`);
  console.log('');
  console.log(`  WATERFALL (${s.waterfall.turns} turns, medians)`);
  line('vad', fmt(s.waterfall.vad));
  line('stt_final', fmt(s.waterfall.stt));
  line('llm_ttft', fmt(s.waterfall.llmTtft));
  line('tts_ttfb', fmt(s.waterfall.ttsTtfb));
  line('first_audio', `p50 ${fmt(s.waterfall.firstAudio)}  p95 ${fmt(s.waterfall.firstAudioP95)}`);
  console.log('');
  console.log('  USAGE (per run, all calls)');
  line('llm tokens in/out', `${s.usage.llmTokensIn}/${s.usage.llmTokensOut}`);
  line('tts chars / requests', `${s.usage.ttsChars} / ${s.usage.ttsRequests}`);
  if (crossCheck) {
    console.log('');
    line('GET /api/calls', crossCheck.error ? `unavailable — ${crossCheck.error}` : `${crossCheck.seen}/${crossCheck.total} visible`);
  }
  console.log('');
  if (s.modes.length && !s.modes.includes(MODE)) {
    console.log(
      `  !! MISLABELLED RUN: --mode=${MODE} but the records say ${s.modes.join(', ')}. ` +
        `The server is not on the brain this row claims — restart it with VOICE_BRAIN=${MODE}.`
    );
  }
  if (!s.waterfall.turns) {
    console.log('  note: no turn reached the brain — a 440 Hz tone is not speech. Plumbing numbers stand; model numbers are n/a.');
  }
}

const HEADER = `# V7 A/B results — cascade vs live

Appended by \`scripts/cascade-ab.js\`. Every row is ONE run of N synthetic calls
against a locally running server on ONE brain (VOICE_BRAIN is read at boot, so a
per-call flip is impossible). The caller is an in-process werift peer sending a
440 Hz tone, so the plumbing columns are measured end to end while the model
columns are read back off the call records the server wrote.

| when | mode | calls ok | connect p50 | greeting p50 / p95 | turn p50 / p95 | rec turns | llm_ttft p50 | tts_ttfb p50 | first_audio p50 / p95 | chain |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
`;

function appendRow(s) {
  if (!existsSync(RESULTS_FILE)) writeFileSync(RESULTS_FILE, HEADER);
  const cell = (v) => (v == null ? 'n/a' : String(Math.round(v)));
  const row =
    `| ${new Date().toISOString().replace('T', ' ').slice(0, 16)} ` +
    `| \`${MODE}\` ` +
    `| ${s.ok}/${s.placed} ` +
    `| ${cell(s.connect.p50)} ` +
    `| ${cell(s.greeting.p50)} / ${cell(s.greeting.p95)} ` +
    `| ${cell(s.turn.p50)} / ${cell(s.turn.p95)} ` +
    `| ${s.recTurns} ` +
    `| ${cell(s.waterfall.llmTtft)} ` +
    `| ${cell(s.waterfall.ttsTtfb)} ` +
    `| ${cell(s.waterfall.firstAudio)} / ${cell(s.waterfall.firstAudioP95)} ` +
    `| ${s.providers.join(' / ') || 'n/a'} |\n`;
  appendFileSync(RESULTS_FILE, row);
  console.log(`  row appended → ${path.relative(ROOT, RESULTS_FILE)}`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[ab] mode=${MODE} calls=${CALLS} app=${APP} graph=http://localhost:${GRAPH_PORT}`);
  console.log(`[ab] the app must be running with VOICE_CALL_TRANSPORT=real VOICE_CALL_GRAPH_BASE=http://localhost:${GRAPH_PORT}`);

  let health;
  try {
    health = await fetch(`${APP}/health`);
  } catch (err) {
    console.error(`[ab] the app is not reachable at ${APP} — start it first (${err?.message || err})`);
    process.exit(1);
  }
  if (!health.ok) {
    console.error(`[ab] ${APP}/health returned HTTP ${health.status}`);
    process.exit(1);
  }

  let werift;
  try {
    werift = await import('werift');
  } catch (err) {
    console.error(`[ab] werift failed to load: ${err?.message || err}`);
    process.exit(1);
  }

  const server = await startGraph();
  const rows = [];
  try {
    for (let i = 1; i <= CALLS; i += 1) {
      process.stdout.write(`[ab] call ${i}/${CALLS} … `);
      const row = await placeCall(i, werift);
      rows.push(row);
      console.log(
        row.error
          ? `FAILED — ${row.error}`
          : `connect ${fmt(row.connectMs)} greeting ${fmt(row.greetingMs)} turn ${fmt(row.turnMs)} (${row.rtpIn} rtp in)`
      );
      // A setup problem (closed clinic, wrong tenant) is the same on call 10 as
      // it was on call 1 — do not grind through nine more to prove it.
      if (row.fatal) {
        console.log('[ab] aborting the run: that is a setup problem, not a slow brain.');
        break;
      }
      if (i < CALLS) await sleep(GAP_MS);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }

  const records = await readRecords(rows.map((r) => r.callId));
  const crossCheck = await apiCrossCheck(rows.map((r) => r.callId));
  const s = summarize(rows, records);
  printSummary(s, crossCheck);
  // Persist ONLY honest rows: a mislabelled run (the records name a different
  // brain than --mode claims) or a run where nothing connected would poison
  // the exact table the P3 go/no-go reads. The stdout warning explains why
  // nothing was written (review finding).
  const mislabelled = s.modes.length && !s.modes.includes(MODE);
  if (WRITE && s.ok && !mislabelled) appendRow(s);
  else if (WRITE) console.log('[ab] row NOT appended (mislabelled or zero completed calls)');
  // A run where nothing connected is a broken setup, not a slow brain.
  process.exit(s.ok && !mislabelled ? 0 : 1);
}

main().catch((err) => {
  console.error('[ab] fatal:', err?.stack || err);
  process.exit(1);
});
