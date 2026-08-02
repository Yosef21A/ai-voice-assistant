// V8 — THE SPEECH-DRIVEN CALL SELF-TEST. The agent is called, in derja, by a
// robot that behaves like a difficult Tunisian caller, and scored against the
// Monday acceptance bars.
//
//   node scripts/call-selftest.js [--scenario booking|backchannel|correction|silence|all]
//                                 [--skip-synthesis] [--verbose] [--no-write]
//
// ── WHY THIS EXISTS, GIVEN scripts/cascade-ab.js ALREADY DOES THIS ──────────
// It does not. The A/B harness sends a 440 Hz tone: real UDP, real SDP, real
// webhooks — and not one word. It measures the PLUMBING (connect, accept,
// greeting, turn) and says so honestly, and on a well-behaved STT leg it records
// ZERO turns because a sine wave is not speech. Every V8 acceptance bar is about
// what happens AFTER the STT fires:
//
//     zero double-replies · felt latency ≤1.3 s median · the agent survives
//     «باهي» mid-sentence · the booking lands with the right spell-back
//
// None of those can be observed by a tone. So this script reuses the harness's
// good bones (in-process werift caller, local Graph stub, webhook posting,
// call-record extraction) and replaces the tone with Fish-synthesized derja,
// plus a turn-taking driver that listens to the agent's RTP and answers like a
// person: after it stops talking — or, twice on purpose, straight over it.
//
// ── ISOLATION IS NOT A NICETY HERE ──────────────────────────────────────────
// This talks to REAL Gemini and REAL Fish with the founder's keys, so it must
// never be able to touch the running product. It follows test/voicecall.p2
// .integration.test.js's law exactly: a real createApp on its own config, a temp
// runtimeDir under os.tmpdir(), an EPHEMERAL port. It never binds :3000, never
// reads or writes data/runtime (the one exception is data/runtime/selftest-voice/,
// which holds the CALLER's cached clips and nothing the app can see), and never
// edits data/clinics.json.
//
// The 24/7 override is the one seam worth naming: the JSON store loads
// data/clinics.json ONCE into memory as a read-only seed (src/store/adapters/
// json/index.js — `clinics` is never persisted back), and `store.getClinicById()`
// hands back that live object. Mutating `workingHours` on it therefore changes
// this process's view and nothing else — no file is written, and the seam is the
// same one PUT /api/tenant already uses. A closed clinic rejects every call by
// design, which is the #1 way a rehearsal produces nothing at 03:00.
//
// ── WHAT IS MEASURED, AND FROM WHERE ────────────────────────────────────────
//   • replies-per-utterance — the `[rtp-out] src=… utt=… frames=…` lines the
//     app logs, which is the acceptance instrument V7-P2.1 specified. Contiguous
//     `src=turn` segments sharing an utterance id are ONE reply; a second RUN for
//     an utterance already answered is the double reply.
//   • felt latency — `first_audio_ms` off the per-turn waterfalls on the stored
//     call record. Not a stopwatch in this script: the number the founder argues
//     about must be the number the product itself wrote down.
//   • backchannel survived — the wire (did agent audio continue through the
//     «باهي»?) AND the log (`backchannel … while speaking — ignored`, and no
//     `[rtp-out] killed … (barge_in)` in the window). Two independent tells,
//     because a sentence that happened to end right then would fool either one.
//   • booking correctness — appointments.json in the ISOLATED runtime.
//   • hang-up honored — the `terminate` action our Graph stub received.
//
// ── WHAT THIS CANNOT TELL THE FOUNDER ───────────────────────────────────────
// Whether it SOUNDS right. A synthetic caller reads flat, never overlaps a
// syllable the way a person does, and cannot judge whether the derja is warm or
// robotic. This clears the mechanical bars so the founder's live ear-test is
// spent on the thing only an ear can score.
import express from 'express';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_FILE = path.join(ROOT, 'docs', 'V8-SELFTEST.md');
const VOICE_DIR = path.join(ROOT, 'data', 'runtime', 'selftest-voice');

// ════════════════════════════════════════════════════════════════════════════
// ARGV — parsed FIRST, so --help never boots anything and never opens a socket
// ════════════════════════════════════════════════════════════════════════════
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

const HELP = `
V8 speech-driven call self-test — the agent answers a robot that speaks derja.

  node scripts/call-selftest.js [options]

  --scenario NAME     booking | backchannel | correction | silence | all   (booking)
  --skip-synthesis    use only clips already cached in data/runtime/selftest-voice/
  --graph-port N      port for this script's local "Meta Graph" stub          (3903)
  --pnid ID           tenant phone_number_id                     (el-amen's, from clinics.json)
  --from WAID         the synthetic caller's WhatsApp id                (216SELFTEST01)
  --cap-ms N          hard ceiling on ONE call                            (240000)
  --turn-ms N         per-turn timeout waiting for a reply                 (15000)
  --quiet-ms N        agent silence that means "your turn"                   (700)
  --verbose           mirror the app's own log lines to stderr as they happen
  --keep-runtime      do NOT delete the temp runtime dir (for post-mortems)
  --no-write          print the scorecards, do not touch docs/V8-SELFTEST.md
  --help              this text (touches no network, boots nothing)

Needs GEMINI_API_KEY and FISH_AUDIO_API in .env — this is the self-test, it
talks to the real providers. It boots its OWN app on an ephemeral port with its
OWN runtime dir under the system temp; :3000 and data/runtime are never touched.
`;

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════
const FRAME_MS = 20;
const GRAPH_PORT = Number(args['graph-port']) || 3903;
const FROM = String(args.from || '216SELFTEST01');
const CALL_CAP_MS = Number(args['cap-ms']) || 240000;
const TURN_TIMEOUT_MS = Number(args['turn-ms']) || 15000;
/** Agent silence, after agent speech, that hands the floor back to the caller. */
const QUIET_MS = Number(args['quiet-ms']) || 700;
/** Inbound gap that splits one agent utterance from the next, for the wire log. */
const SEG_GAP_MS = 250;
const VERBOSE = args.verbose === true;
const WRITE = args.write !== false;
const KEEP_RUNTIME = args['keep-runtime'] === true;

/** The V8 bar, verbatim from docs/VOICE-AGENT-SPEC.md §V8 Acceptance. */
const FELT_MEDIAN_BAR_MS = 1300;
const FELT_WORST_BAR_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s = '') => process.stdout.write(`${s}\n`);

function percentile(values, p) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
const median = (v) => percentile(v, 0.5);
const ms = (v) => (v == null ? 'n/a' : `${Math.round(v)}ms`);
const yn = (v) => (v == null ? 'n/a' : v ? 'YES' : 'NO');

// ════════════════════════════════════════════════════════════════════════════
// THE APP'S OWN VOICE — every console line, timestamped, in order
// ════════════════════════════════════════════════════════════════════════════
// The app under test is IN THIS PROCESS, and the voice service logs through
// console.error by default (src/voice-call/index.js). That makes the `[rtp-out]`
// and `[voice-cascade]` lines — the exact acceptance instrument V7-P2.1 named —
// readable without parsing a file or shelling out. They are captured rather than
// printed so a 90-second call does not bury the scorecard; --verbose mirrors them.
const logLines = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let capturing = false;

function capture(level, argv) {
  const text = argv
    .map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack || x.message : String(x)))
    .join(' ');
  logLines.push({ at: Date.now(), level, text });
  if (VERBOSE) process.stderr.write(`  · ${text}\n`);
}

function startCapture() {
  if (capturing) return;
  capturing = true;
  console.log = (...a) => capture('log', a);
  console.warn = (...a) => capture('warn', a);
  console.error = (...a) => capture('error', a);
}

function stopCapture() {
  if (!capturing) return;
  capturing = false;
  Object.assign(console, realConsole);
}

/** Log lines emitted inside [from, to). */
const linesBetween = (from, to = Infinity) => logLines.filter((l) => l.at >= from && l.at < to);

// PROCESS-LEVEL SAFETY NETS. The V7-P2.1 killer was an unhandled rejection from
// a cancelled TTS body taking the whole server down mid-call. Registering these
// suppresses the default fatal exit — which is exactly why every one caught here
// is a HARD FAIL on the scorecard rather than a footnote.
const processFaults = [];
process.on('unhandledRejection', (reason) => {
  processFaults.push({ at: Date.now(), kind: 'unhandledRejection', text: String(reason?.stack || reason) });
  capture('error', ['[selftest] UNHANDLED REJECTION:', String(reason?.stack || reason)]);
});
process.on('uncaughtException', (err) => {
  processFaults.push({ at: Date.now(), kind: 'uncaughtException', text: String(err?.stack || err) });
  capture('error', ['[selftest] UNCAUGHT EXCEPTION:', String(err?.stack || err)]);
});

// ════════════════════════════════════════════════════════════════════════════
// THE "META GRAPH" — the same stub scripts/cascade-ab.js serves, on its own port
// ════════════════════════════════════════════════════════════════════════════
/** callId → { actions[], at:{action:ms}, sdpAnswer, accepted, ended } */
const graphCalls = new Map();

function startGraphStub(port) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // Any version segment, so bumping WHATSAPP_GRAPH_VERSION cannot silently 404.
  app.post('/:version/:pnid/calls', (req, res) => {
    const { call_id: callId, action, session } = req.body || {};
    const c = graphCalls.get(String(callId));
    if (c) {
      c.actions.push(action);
      c.at[action] = Date.now();
      if (session?.sdp && !c.sdpAnswer) c.sdpAnswer = session.sdp;
      if (action === 'accept') c.accepted = true;
      if (action === 'reject' || action === 'terminate') c.ended = action;
    }
    res.json({ success: true });
  });
  app.get('/health', (_req, res) => res.json({ ok: true, calls: graphCalls.size }));
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// THE WEBHOOK BODIES (Meta's exact shape)
// ════════════════════════════════════════════════════════════════════════════
function callEnvelope(pnid, call) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'V8-SELFTEST',
        changes: [
          {
            field: 'calls',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+216 73 000 111', phone_number_id: pnid },
              calls: [call],
            },
          },
        ],
      },
    ],
  };
}

const connectBody = (pnid, callId, sdp) =>
  callEnvelope(pnid, {
    id: callId,
    from: FROM,
    to: pnid,
    event: 'connect',
    direction: 'USER_INITIATED',
    timestamp: String(Math.floor(Date.now() / 1000)),
    session: { sdp_type: 'offer', sdp },
  });

const terminateBody = (pnid, callId, startedAt) =>
  callEnvelope(pnid, {
    id: callId,
    from: FROM,
    to: pnid,
    event: 'terminate',
    direction: 'USER_INITIATED',
    status: 'Completed',
    start_time: String(Math.floor(startedAt / 1000)),
    end_time: String(Math.floor(Date.now() / 1000)),
    duration: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
  });

async function postWebhook(base, body) {
  const r = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`the app rejected a webhook (HTTP ${r.status})`);
  return r;
}

// ════════════════════════════════════════════════════════════════════════════
// THE SCENARIOS — a tiny step DSL, so the flows read like the demo script
// ════════════════════════════════════════════════════════════════════════════
// step kinds:
//   greeting                 wait for the agent to greet, then hand it back
//   say                      wait for quiet → play a clip → wait for the reply
//   sayAfter                 play a clip after a FIXED gap (no waiting) — the
//                            mid-number pause a human makes reading a card
//   sayInto                  wait for the agent to START speaking, then talk
//                            over it at +afterMs. `probe` names what it tests.
//   quiet                    say nothing at all for ms — the silence ladder
//   bye                      the farewell, then wait for the app to hang up
const SCENARIOS = {
  booking: {
    title: 'booking happy path (through spell-back to a confirmed reference)',
    needs: ['book', 'specialty', 'day', 'name', 'phone1', 'phone2', 'confirm', 'bye'],
    bars: ['doubles', 'latency', 'booking', 'hangup'],
    // The rehearsed 90-second demo flow, in order. A fixed script cannot answer
    // a question it did not expect, so `confirm` appears TWICE on purpose: once
    // to accept whatever slot the agent offers (it negotiates — on an earlier
    // run it counter-offered a different half of the day, and every later line
    // landed a beat behind) and once to accept the spell-back. «باهي» is not
    // here: on a quiet wire it is an acknowledgment that buys nothing, and its
    // real job — surviving mid-sentence — is the whole of the backchannel
    // scenario below.
    steps: [
      { kind: 'greeting' },
      { kind: 'say', clip: 'book' },
      { kind: 'say', clip: 'specialty' },
      { kind: 'say', clip: 'day' },
      { kind: 'say', clip: 'confirm' },
      { kind: 'say', clip: 'name' },
      // THE PATIENT-ENDPOINTER TEST: one number, two clips, a human-sized pause
      // in the middle. A 400 ms endpointer answers between them; the 900 ms
      // data-capture endpointer (V8-D2 §1), and liveEars' 1200 ms patient idle
      // timer, wait for the rest.
      //
      // The total gap is ~600 ms, NOT the 1100 ms it started at: 1100 sat right
      // on liveEars' 1200 ms patient window, so the transcriber's own lag
      // decided the outcome and the number arrived in two halves about half the
      // time. 600 ms is both a realistic pause and a measurement rather than a
      // coin toss. Widening it past 1200 ms is a legitimate future experiment —
      // it is the endpointer's stated limit, and it should be tested on purpose,
      // not by accident.
      { kind: 'say', clip: 'phone1', expectReply: false, settleMs: 150 },
      { kind: 'sayAfter', clip: 'phone2', gapMs: 450 },
      // …and THREE «نعم صحيح» in total, because the agent legitimately spends a
      // variable number of beats here: a slot list, sometimes a lookup turn of
      // its own, then the spell-back. A script that answers exactly as many
      // questions as it expects will miss the recap by one turn whenever the
      // model takes an extra one — which is what happened on the run where the
      // spell-back came back word-perfect and the caller said goodbye to it.
      // A caller who says "yes, correct" to a question already answered is
      // harmless; one who never reaches confirm_booking scores a false FAIL.
      { kind: 'say', clip: 'confirm' },
      { kind: 'say', clip: 'confirm' },
      { kind: 'bye' },
    ],
  },
  backchannel: {
    title: 'backchannel immunity («باهي» mid-sentence must not stop the agent)',
    needs: ['book', 'ack', 'bye'],
    bars: ['doubles', 'latency', 'backchannel', 'hangup'],
    steps: [
      { kind: 'greeting' },
      { kind: 'say', clip: 'book' },
      { kind: 'say', clip: 'specialty', expectReply: false, settleMs: 100 },
      { kind: 'sayInto', clip: 'ack', afterMs: 500, probe: 'backchannel', watchMs: 2500 },
      { kind: 'bye' },
    ],
    // `specialty` is played only to guarantee a LONG agent reply to interrupt;
    // the probe is the «باهي» that lands 500 ms into it.
    extraNeeds: ['specialty'],
  },
  correction: {
    title: 'correction (a real interruption MUST stop the agent)',
    needs: ['book', 'specialty', 'day', 'correction', 'bye'],
    bars: ['doubles', 'latency', 'correction', 'hangup'],
    steps: [
      { kind: 'greeting' },
      { kind: 'say', clip: 'book' },
      { kind: 'say', clip: 'specialty' },
      { kind: 'say', clip: 'day', expectReply: false, settleMs: 100 },
      { kind: 'sayInto', clip: 'correction', afterMs: 600, probe: 'correction', watchMs: 3500 },
      { kind: 'bye' },
    ],
  },
  silence: {
    title: 'silence ladder (25 s of nothing → one check-in → goodbye → hang-up)',
    needs: [],
    bars: ['doubles', 'silence'],
    steps: [
      { kind: 'greeting' },
      // 25 s covers the whole ladder with room to spare: check-in at ~10 s after
      // our last audio, goodbye ~8 s later, then the ordinary end_call hang-up.
      { kind: 'quiet', ms: 25000, probe: 'silence' },
      { kind: 'awaitTerminate', withinMs: 6000, optional: true },
    ],
  },
};

const SCENARIO_ORDER = ['booking', 'backchannel', 'correction', 'silence'];

function clipsNeeded(names) {
  const set = new Set();
  for (const n of names) {
    const s = SCENARIOS[n];
    for (const k of s.needs) set.add(k);
    for (const k of s.extraNeeds || []) set.add(k);
    for (const step of s.steps) if (step.clip) set.add(step.clip);
  }
  return [...set];
}

// ════════════════════════════════════════════════════════════════════════════
// THE CALLER — an in-process werift peer that speaks, and listens for its turn
// ════════════════════════════════════════════════════════════════════════════
const rand32 = () => Math.floor(Math.random() * 0xffffffff) >>> 0;
const rand16 = () => Math.floor(Math.random() * 0xffff) & 0xffff;

/**
 * Run ONE scenario as ONE call.
 *
 * @param {object} p
 * @param {object} p.werift
 * @param {object} p.scenario
 * @param {Map<string,Int16Array>} p.clips
 * @param {number} p.callerRate
 * @param {string} p.appBase
 * @param {string} p.pnid
 * @param {Function} p.createCodecBridge
 * @returns {Promise<object>} the wire-side record of the call
 */
async function placeCall({ werift, name, scenario, clips, callerRate, appBase, pnid, createCodecBridge }) {
  const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } = werift;
  const callId = `wacid.V8SELF-${name.toUpperCase()}-${Date.now()}`;
  const wire = {
    name,
    callId,
    startedAt: Date.now(),
    acceptedAt: null,
    greetingAt: null,
    endedAt: null,
    error: null,
    /** Arrival time of every inbound agent RTP packet — the agent's speech, on the wire. */
    agentPackets: [],
    utterances: [],
    probes: [],
    rtpOut: 0,
    terminatedAt: null,
  };

  const pc = new RTCPeerConnection({
    // Loopback both ends: depending on a public STUN server would make a latency
    // measurement hostage to the founder's Wi-Fi (cascade-ab's lesson, kept).
    iceServers: [],
    codecs: {
      audio: [
        new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }),
        new RTCRtpCodecParameters({ mimeType: 'audio/telephone-event', clockRate: 8000 }),
      ],
    },
  });
  const outTrack = new MediaStreamTrack({ kind: 'audio' });

  // Subscribe BEFORE setRemoteDescription — werift fires onTrack synchronously
  // while applying the remote SDP (the lesson already written into media.js).
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe(() => {
      const at = Date.now();
      wire.agentPackets.push(at);
      if (!wire.greetingAt) wire.greetingAt = at;
    });
  });

  const entry = { actions: [], at: {}, sdpAnswer: null, accepted: false, ended: null };
  graphCalls.set(callId, entry);

  /** The agent's last audio frame, or 0 if it has never spoken. */
  const lastAgentAt = () => (wire.agentPackets.length ? wire.agentPackets[wire.agentPackets.length - 1] : 0);
  const agentSpokeSince = (t) => lastAgentAt() > t;

  let pacer = null;
  let codec = null;

  try {
    // BEFORE createOffer, always: an offer built without the track is recvonly,
    // no uplink RTP ever flows, media never connects and the app never accepts —
    // which reads on this side as "the app ignored the call".
    pc.addTrack(outTrack);
    await pc.setLocalDescription(await pc.createOffer());
    const offer = pc.localDescription?.sdp;
    if (!offer) throw new Error('werift produced no local SDP');

    await postWebhook(appBase, connectBody(pnid, callId, offer));

    const until = Date.now() + 25000;
    while (!entry.sdpAnswer && !entry.ended && Date.now() < until) await sleep(10);
    if (entry.ended === 'reject') {
      const e = new Error(`the clinic DECLINED the call — the 24/7 override did not take on ${pnid}`);
      e.fatal = true;
      throw e;
    }
    if (entry.ended) throw new Error(`the app ended the call before answering (${entry.ended})`);
    if (!entry.sdpAnswer) throw new Error('no pre_accept within 25s — is the app pointed at the Graph stub?');

    await pc.setRemoteDescription({ type: 'answer', sdp: entry.sdpAnswer });
    while (!entry.accepted && !entry.ended && Date.now() < until) await sleep(10);
    if (!entry.accepted) throw new Error('the app never accepted the call (ICE/DTLS never completed)');
    wire.acceptedAt = entry.at.accept;

    // ── the uplink: CONTINUOUS RTP, exactly like a real phone ───────────────
    // A real caller's microphone never stops sending. Going silent by sending
    // NOTHING would deprive every VAD in the chain of the pause it endpoints on,
    // and would make this harness measure a leg no Meta caller ever presents.
    // So the pacer sends a frame every 20 ms forever: the clip when there is
    // one, digital silence when there is not.
    codec = createCodecBridge({ sdpOffer: offer, sdpAnswer: entry.sdpAnswer, logger: () => {} });
    const srcFrameSamples = Math.round((callerRate * FRAME_MS) / 1000);
    const silence = new Int16Array(srcFrameSamples);
    /** Queued caller PCM at `callerRate`, drained one 20 ms frame per tick. */
    let queue = [];
    let queued = 0;
    let seq = rand16();
    let ts = rand32();
    const ssrc = rand32();
    let mark = true;
    let anchor = null;
    let slots = 0;

    const pullFrame = () => {
      if (!queued) return silence;
      const frame = new Int16Array(srcFrameSamples);
      let need = srcFrameSamples;
      let at = 0;
      while (need > 0 && queue.length) {
        const head = queue[0];
        const take = Math.min(need, head.length);
        frame.set(head.subarray(0, take), at);
        at += take;
        need -= take;
        queued -= take;
        if (take === head.length) queue.shift();
        else queue[0] = head.subarray(take);
      }
      return frame;
    };

    const sendFrame = () => {
      const pcm = pullFrame();
      const payloads = codec.encodeOut(pcm, callerRate);
      for (const payload of payloads) {
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
          wire.rtpOut += 1;
        } catch {
          /* a dropped uplink frame is not worth ending a measurement over */
        }
      }
    };

    // Drift-corrected, exactly like the orchestrator's own pacer: Windows timers
    // wander, and an uplink that wanders makes every endpointing number a lie.
    pacer = setInterval(() => {
      const now = Date.now();
      if (anchor == null) anchor = now - FRAME_MS;
      let due = Math.min(25, Math.floor((now - anchor) / FRAME_MS) - slots);
      while (due-- > 0) {
        slots += 1;
        sendFrame();
      }
    }, FRAME_MS);
    pacer.unref?.();

    // ── the driver's primitives ─────────────────────────────────────────────
    const deadline = Date.now() + CALL_CAP_MS;
    const capped = () => Date.now() > deadline;

    /** Push a clip (plus a short in-band tail) and resolve when it has all left. */
    const say = async (clip) => {
      const pcm = clips.get(clip);
      if (!pcm) throw new Error(`clip ${clip} was never synthesized`);
      const startedAt = Date.now();
      queue.push(pcm);
      queued += pcm.length;
      const rec = { clip, startedAt, endedAt: null, ms: Math.round((pcm.length / callerRate) * 1000) };
      wire.utterances.push(rec);
      while (queued > 0 && !capped()) await sleep(10);
      rec.endedAt = Date.now();
      return rec;
    };

    /** Wait until the agent has been quiet for `silenceMs`. Never blocks forever. */
    const waitQuiet = async (silenceMs = QUIET_MS, timeoutMs = TURN_TIMEOUT_MS) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const last = lastAgentAt();
        if (last && Date.now() - last >= silenceMs) return true;
        if (!last) return true; // it has never spoken; the floor is already ours
        if (Date.now() > until || capped()) return false;
        await sleep(20);
      }
    };

    /** Wait for the agent to answer `since`, then for it to finish. */
    const waitReply = async (since, timeoutMs = TURN_TIMEOUT_MS) => {
      const until = Date.now() + timeoutMs;
      while (!agentSpokeSince(since)) {
        if (Date.now() > until || capped()) return { spoke: false, firstAt: null };
        await sleep(20);
      }
      const firstAt = wire.agentPackets.find((t) => t > since) || null;
      await waitQuiet(QUIET_MS, timeoutMs);
      return { spoke: true, firstAt };
    };

    /** Wait for the agent to START speaking (≥3 frames, so a stray is not "speech"). */
    const waitSpeaking = async (since, timeoutMs = TURN_TIMEOUT_MS) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const after = wire.agentPackets.filter((t) => t > since);
        if (after.length >= 3) return after[0];
        if (Date.now() > until || capped()) return null;
        await sleep(10);
      }
    };

    // ── run the steps ───────────────────────────────────────────────────────
    for (const step of scenario.steps) {
      if (capped()) {
        wire.error = wire.error || `call cap (${CALL_CAP_MS}ms) reached at step ${step.kind}`;
        break;
      }

      if (step.kind === 'greeting') {
        const at = await waitSpeaking(wire.acceptedAt - 1, TURN_TIMEOUT_MS);
        wire.greetingMs = at ? at - wire.acceptedAt : null;
        await waitQuiet(QUIET_MS, TURN_TIMEOUT_MS);
        continue;
      }

      if (step.kind === 'say') {
        await waitQuiet(QUIET_MS, TURN_TIMEOUT_MS);
        const rec = await say(step.clip);
        if (step.expectReply === false) {
          await sleep(step.settleMs ?? 500);
        } else {
          const r = await waitReply(rec.endedAt, TURN_TIMEOUT_MS);
          rec.replied = r.spoke;
          rec.replyLatencyMs = r.firstAt ? r.firstAt - rec.endedAt : null;
          if (!r.spoke) wire.silentTurns = (wire.silentTurns || 0) + 1;
        }
        continue;
      }

      if (step.kind === 'sayAfter') {
        await sleep(step.gapMs ?? 800);
        const rec = await say(step.clip);
        const r = await waitReply(rec.endedAt, TURN_TIMEOUT_MS);
        rec.replied = r.spoke;
        rec.replyLatencyMs = r.firstAt ? r.firstAt - rec.endedAt : null;
        if (!r.spoke) wire.silentTurns = (wire.silentTurns || 0) + 1;
        continue;
      }

      if (step.kind === 'sayInto') {
        const mark = Date.now();
        const speakingAt = await waitSpeaking(mark, TURN_TIMEOUT_MS);
        const probe = { probe: step.probe, clip: step.clip, agentStartedAt: speakingAt, firedAt: null, watchMs: step.watchMs };
        wire.probes.push(probe);
        if (!speakingAt) {
          probe.skipped = 'the agent never started speaking — nothing to talk over';
          continue;
        }
        await sleep(step.afterMs ?? 500);
        probe.firedAt = Date.now();
        const rec = await say(step.clip);
        probe.clipEndedAt = rec.endedAt;
        // Watch the wire for a fixed window; the scorer reads agentPackets.
        await sleep(step.watchMs ?? 2500);
        probe.watchedUntil = Date.now();
        await waitQuiet(QUIET_MS, TURN_TIMEOUT_MS);
        continue;
      }

      if (step.kind === 'quiet') {
        const from = Date.now();
        wire.probes.push({ probe: step.probe, quietFrom: from, quietMs: step.ms });
        const until = from + step.ms;
        while (Date.now() < until && !entry.ended && !capped()) await sleep(50);
        continue;
      }

      if (step.kind === 'bye') {
        await waitQuiet(QUIET_MS, TURN_TIMEOUT_MS);
        const rec = await say('bye');
        wire.byeEndedAt = rec.endedAt;
        // THE HANG-UP BAR: the app must terminate the call ITSELF, and soon.
        const until = Date.now() + (step.withinMs ?? 10000);
        while (!entry.at.terminate && Date.now() < until && !capped()) await sleep(50);
        continue;
      }

      if (step.kind === 'awaitTerminate') {
        const until = Date.now() + (step.withinMs ?? 10000);
        while (!entry.at.terminate && Date.now() < until && !capped()) await sleep(50);
        continue;
      }

      throw new Error(`unknown step kind ${JSON.stringify(step.kind)}`);
    }

    wire.terminatedAt = entry.at.terminate || null;
    // Whoever hangs up first, the CALLER always closes the books: Meta's own
    // terminate arrives for a caller-side hang-up, and the app must survive both
    // orders. Sending it after an app-side terminate is a no-op it already dedupes.
    if (!entry.at.terminate) {
      await postWebhook(appBase, terminateBody(pnid, callId, wire.startedAt)).catch(() => {});
    }
  } catch (err) {
    wire.error = err?.message || String(err);
    wire.fatal = !!err?.fatal;
    try {
      await postWebhook(appBase, terminateBody(pnid, callId, wire.startedAt));
    } catch {
      /* the app's own watchdog closes the books either way */
    }
  } finally {
    if (pacer) clearInterval(pacer);
    try {
      codec?.close();
    } catch {
      /* best effort */
    }
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
    wire.endedAt = Date.now();
    wire.terminatedAt = wire.terminatedAt || entry.at.terminate || null;
    wire.graphActions = entry.actions.slice();
  }
  return wire;
}

// ════════════════════════════════════════════════════════════════════════════
// SCORING
// ════════════════════════════════════════════════════════════════════════════
/** Split the inbound packet stream into the agent's utterances. */
function agentSegments(packets, gapMs = SEG_GAP_MS) {
  const segs = [];
  for (const t of packets) {
    const last = segs[segs.length - 1];
    if (last && t - last.endAt <= gapMs) {
      last.endAt = t;
      last.frames += 1;
    } else segs.push({ startAt: t, endAt: t, frames: 1 });
  }
  return segs;
}

const RTP_OUT_RE = /\[rtp-out\] src=(\S+) utt=(\S+) frames=(\d+)/;
const KILLED_RE = /\[rtp-out\] killed (\d+) queued frames \(([^)]+)\)/;
const STALE_RE = /\[rtp-out\] dropped (\d+) frames: stale gen/;

/**
 * READ THE WIRE LOG. This is the V7-P2.1 acceptance instrument, unchanged:
 * every frame the app sent is source-tagged and carries the utterance it
 * answers, so "one reply per utterance" is a thing you COUNT.
 *
 * A single reply is normally several `src=turn` segments (one per sentence, the
 * queue emptying between them), all sharing an utterance id — so segments are
 * collapsed into RUNS, and a second run for an utterance that already had one is
 * the double reply.
 */
function readWireLog(lines) {
  const segs = [];
  const kills = [];
  let staleFrames = 0;
  const bySrc = {};
  for (const l of lines) {
    let m = RTP_OUT_RE.exec(l.text);
    if (m) {
      const seg = { at: l.at, src: m[1], utt: m[2], frames: Number(m[3]) };
      segs.push(seg);
      bySrc[seg.src] = (bySrc[seg.src] || 0) + seg.frames;
      continue;
    }
    m = KILLED_RE.exec(l.text);
    if (m) {
      kills.push({ at: l.at, frames: Number(m[1]), reason: m[2] });
      continue;
    }
    m = STALE_RE.exec(l.text);
    if (m) staleFrames += Number(m[1]);
  }

  const runs = [];
  for (const s of segs.filter((x) => x.src === 'turn' && x.utt !== '-')) {
    const last = runs[runs.length - 1];
    if (last && last.utt === s.utt) {
      last.frames += s.frames;
      last.endAt = s.at;
    } else runs.push({ utt: s.utt, frames: s.frames, startAt: s.at, endAt: s.at });
  }
  const perUtt = new Map();
  for (const r of runs) perUtt.set(r.utt, (perUtt.get(r.utt) || 0) + 1);
  const doubles = [...perUtt.entries()].filter(([, n]) => n > 1).map(([utt, n]) => ({ utt, replies: n }));

  return {
    segs,
    kills,
    staleFrames,
    bySrc,
    specFrames: bySrc.spec || 0,
    answeredUtterances: perUtt.size,
    replyRuns: runs.length,
    doubles,
    maxRepliesPerUtterance: perUtt.size ? Math.max(...perUtt.values()) : 0,
    ledgerRefusals: lines.filter((l) => /ledger REFUSED|ledger refused/i.test(l.text)).length,
    backchannelIgnored: lines.filter((l) => /backchannel .*(ignored|not an interruption|part of it)/i.test(l.text)),
    fragmentsRefused: lines.filter((l) => /is a fragment, not a turn/.test(l.text)).length,
    silenceCheckIn: lines.filter((l) => /still silent after the check-in/.test(l.text)).length,
    cascadeUnavailable: lines.filter((l) => /cascade unavailable/.test(l.text)).map((l) => l.text),
  };
}

/** The stored call record for this callId, from the ISOLATED runtime. */
async function readCallRecord(runtimeDir, callId) {
  const file = path.join(runtimeDir, 'messages.json');
  for (let attempt = 0; attempt < 24; attempt += 1) {
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
      if (call?.callId === callId) return call;
    }
  }
  return null;
}

function readAppointments(runtimeDir) {
  const file = path.join(runtimeDir, 'appointments.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Did the booking land, and is it the one the caller asked for?
 * The caller asked for «طبيب القلب» (cardiology) on «نهار الخميس الصباح»
 * (Thursday morning) — the rehearsed demo flow, verbatim.
 */
function scoreBooking(appointments, callId) {
  const appt = appointments.find((a) => a.channel === 'call') || appointments[appointments.length - 1] || null;
  if (!appt) return { booked: false, appt: null, specialtyOk: null, dayOk: null, timeOk: null };
  const when = appt.datetimeISO ? new Date(appt.datetimeISO) : null;
  const label = `${appt.specialty || ''} ${appt.specialtyLabel || ''}`.toLowerCase();
  return {
    booked: true,
    appt,
    ref: appt.ref || null,
    patientName: appt.patientName || null,
    contact: appt.contact || null,
    when: when ? when.toISOString() : null,
    weekday: when ? WEEKDAYS[when.getDay()] : null,
    specialtyOk: /cardio|قلب|cardiolog/.test(label),
    dayOk: when ? when.getDay() === 4 : null, // Thursday
    timeOk: when ? when.getHours() < 12 : null, // الصباح = morning
    adjusted: !!appt.datetimeAdjusted,
    callId,
  };
}

/** Did «باهي» stop the agent? It must not have. */
function scoreBackchannel(wire, log) {
  const probe = wire.probes.find((p) => p.probe === 'backchannel');
  if (!probe || !probe.firedAt) return { tested: false, reason: probe?.skipped || 'the probe never fired' };
  const from = probe.firedAt;
  const watchUntil = probe.watchedUntil || from + (probe.watchMs || 2500);
  const after = wire.agentPackets.filter((t) => t >= from && t <= watchUntil);
  // How long did the agent keep talking WITHOUT a real gap, from the moment we
  // started talking over it? A backchannel that killed the agent shows up as the
  // wire falling silent inside the barge budget (150 ms) plus jitter.
  let continuedUntil = from;
  for (const t of after) {
    if (t - continuedUntil > SEG_GAP_MS) break;
    continuedUntil = t;
  }
  const continuedMs = continuedUntil - from;
  const killedInWindow = log.kills.filter((k) => k.at >= from - 50 && k.at <= watchUntil && /barge/i.test(k.reason));
  const ignoredInWindow = log.backchannelIgnored.filter((l) => l.at >= from - 500 && l.at <= watchUntil + 1500);
  return {
    tested: true,
    // TWO independent tells, because either alone can be fooled: a sentence that
    // happened to end right then would look like a kill on the wire, and a log
    // line without wire continuity would be a claim rather than a measurement.
    survived: killedInWindow.length === 0 && continuedMs >= 600,
    continuedMs,
    kills: killedInWindow.length,
    ignoredLines: ignoredInWindow.map((l) => l.text.slice(0, 120)),
    agentFramesAfter: after.length,
  };
}

/** Did the correction stop the agent? It must have. */
function scoreCorrection(wire, log) {
  const probe = wire.probes.find((p) => p.probe === 'correction');
  if (!probe || !probe.firedAt) return { tested: false, reason: probe?.skipped || 'the probe never fired' };
  const from = probe.firedAt;
  const watchUntil = probe.watchedUntil || from + (probe.watchMs || 3500);
  const after = wire.agentPackets.filter((t) => t >= from && t <= watchUntil);
  let stoppedAt = null;
  let cursor = from;
  for (const t of after) {
    if (t - cursor > SEG_GAP_MS) {
      stoppedAt = cursor;
      break;
    }
    cursor = t;
  }
  if (stoppedAt == null && after.length && cursor < watchUntil - SEG_GAP_MS) stoppedAt = cursor;
  const killedInWindow = log.kills.filter((k) => k.at >= from - 50 && k.at <= watchUntil && /barge/i.test(k.reason));
  const stopMs = stoppedAt != null ? stoppedAt - from : null;
  return {
    tested: true,
    // The kill CHAIN is the thing under test; the wire going quiet is the proof
    // it reached the socket. 3 s allows for the STT interim that word-gates it.
    stopped: killedInWindow.length > 0 || (stopMs != null && stopMs <= 3000),
    stopMs,
    kills: killedInWindow.length,
    killReasons: [...new Set(killedInWindow.map((k) => k.reason))],
  };
}

/** The silence ladder: one check-in, one goodbye, then the line is released. */
function scoreSilence(wire, log) {
  const probe = wire.probes.find((p) => p.probe === 'silence');
  if (!probe) return { tested: false };
  const from = probe.quietFrom;
  const segs = agentSegments(wire.agentPackets).filter((s) => s.startAt >= from);
  return {
    tested: true,
    utterancesWhileQuiet: segs.length,
    firstAtMs: segs.length ? segs[0].startAt - from : null,
    secondAtMs: segs.length > 1 ? segs[1].startAt - from : null,
    checkIn: segs.length >= 1,
    goodbye: segs.length >= 2,
    endedLine: log.silenceCheckIn > 0,
    terminated: !!wire.terminatedAt,
    terminateAtMs: wire.terminatedAt ? wire.terminatedAt - from : null,
  };
}

/**
 * Everything the run knows about one call, in one object.
 * `record` is what the PRODUCT wrote down; `wire` is what this script heard.
 */
function scoreCall({ wire, record, appointments, lines, scenario }) {
  const log = readWireLog(lines);
  const brain = record?.brain || null;
  const waterfalls = brain?.waterfalls || [];
  const felt = waterfalls.map((w) => w.first_audio_ms).filter((v) => Number.isFinite(v));
  const bars = new Set(scenario.bars);

  const backchannel = bars.has('backchannel') ? scoreBackchannel(wire, log) : { tested: false };
  const correction = bars.has('correction') ? scoreCorrection(wire, log) : { tested: false };
  const silence = bars.has('silence') ? scoreSilence(wire, log) : { tested: false };
  const booking = bars.has('booking') ? scoreBooking(appointments, wire.callId) : { booked: null };

  const feltMedian = median(felt);
  const feltP95 = percentile(felt, 0.95);
  const worst = felt.length ? Math.max(...felt) : null;

  const verdict = [];
  const bar = (label, ok, detail) => verdict.push({ label, ok, detail });

  bar('zero double-replies', log.doubles.length === 0, log.doubles.length ? JSON.stringify(log.doubles) : `${log.answeredUtterances} utterance(s), ${log.replyRuns} reply run(s)`);
  bar('no speculative audio on the wire', log.specFrames === 0, `outBySrc.spec = ${log.specFrames}`);
  bar('no stale frames', log.staleFrames === 0, `${log.staleFrames} dropped`);
  bar('no process-level faults', processFaults.length === 0, processFaults.length ? processFaults.map((f) => f.kind).join(', ') : 'clean');
  // A call that ended `brain_lost` / `tts_lost` degraded to WhatsApp: the caller
  // was hung up on and apologised to in writing. Every other bar can look green
  // on such a call simply because nothing happened, so this one is checked FIRST
  // in spirit and reported as its own line.
  bar(
    'the call ran on the cascade to the end',
    !!brain && brain.mode === 'cascade' && !/lost|failed/.test(String(brain.reason || '')),
    brain ? `ended=${brain.reason} on ${brain.mode}` : 'no call record'
  );
  if (bars.has('latency')) {
    bar(`felt median ≤ ${FELT_MEDIAN_BAR_MS}ms`, feltMedian != null && feltMedian <= FELT_MEDIAN_BAR_MS, `median ${ms(feltMedian)} over ${felt.length} turn(s)`);
    bar(`no turn > ${FELT_WORST_BAR_MS}ms`, worst != null && worst <= FELT_WORST_BAR_MS, `worst ${ms(worst)}`);
  }
  if (bars.has('backchannel')) bar('backchannel survived', backchannel.survived === true, backchannel.tested ? `${backchannel.continuedMs}ms of continued speech, ${backchannel.kills} barge kill(s)` : backchannel.reason);
  if (bars.has('correction')) bar('correction stopped the agent', correction.stopped === true, correction.tested ? `stopped after ${ms(correction.stopMs)}, ${correction.kills} kill(s)` : correction.reason);
  if (bars.has('booking')) {
    bar('booking landed', booking.booked === true, booking.ref ? `ref ${booking.ref}` : 'no appointment row');
    bar('specialty correct (cardiology)', booking.specialtyOk === true, String(booking.appt?.specialtyLabel ?? 'n/a'));
    bar('day correct (Thursday)', booking.dayOk === true, `${booking.weekday ?? 'n/a'} ${booking.when ?? ''}`.trim());
  }
  if (bars.has('hangup')) {
    // Signed on purpose: a terminate that lands BEFORE the farewell is the call
    // collapsing (a lost leg, a degrade), not the agent politely hanging up, and
    // an unsigned `<= 10000` scored that as a pass on the first rehearsal run.
    const after = wire.terminatedAt && wire.byeEndedAt ? wire.terminatedAt - wire.byeEndedAt : null;
    bar(
      'hang-up honored ≤10s',
      !!wire.terminatedAt && (after == null || (after >= 0 && after <= 10000)),
      after != null
        ? `${after}ms ${after < 0 ? 'BEFORE' : 'after'} «بسلامة»`
        : wire.terminatedAt
          ? 'terminated'
          : 'the app never terminated'
    );
  }
  if (bars.has('silence')) {
    bar('one warm check-in', silence.checkIn === true, silence.firstAtMs != null ? `at +${ms(silence.firstAtMs)}` : 'never spoke');
    bar('then a goodbye', silence.goodbye === true, silence.secondAtMs != null ? `at +${ms(silence.secondAtMs)}` : 'no second utterance');
    bar('and the line released', silence.terminated === true, silence.terminateAtMs != null ? `at +${ms(silence.terminateAtMs)}` : 'never terminated');
  }

  return {
    name: wire.name,
    title: scenario.title,
    callId: wire.callId,
    error: wire.error || null,
    wire: {
      greetingMs: wire.greetingMs ?? null,
      utterancesPlayed: wire.utterances.length,
      silentTurns: wire.silentTurns || 0,
      rtpOut: wire.rtpOut,
      rtpIn: wire.agentPackets.length,
      agentUtterances: agentSegments(wire.agentPackets).length,
      durationMs: (wire.endedAt || Date.now()) - wire.startedAt,
      graphActions: wire.graphActions || [],
      replyLatencies: wire.utterances.filter((u) => u.replyLatencyMs != null).map((u) => ({ clip: u.clip, ms: u.replyLatencyMs })),
    },
    record: brain
      ? {
          mode: brain.mode,
          reason: brain.reason,
          providers: brain.providers,
          turns: brain.turns,
          bargeIns: brain.bargeIns,
          waterfalls: waterfalls.length,
          greeting: brain.latency?.greetingMs ?? null,
          greetingSource: brain.latency?.greetingSource ?? null,
          usage: brain.usage,
          booked: brain.booked,
        }
      : null,
    transcript: (record?.transcript || []).map((t) => ({ who: t.who, text: t.text })),
    felt: { median: feltMedian, p95: feltP95, worst, samples: felt },
    log: {
      bySrc: log.bySrc,
      doubles: log.doubles,
      maxRepliesPerUtterance: log.maxRepliesPerUtterance,
      answeredUtterances: log.answeredUtterances,
      replyRuns: log.replyRuns,
      specFrames: log.specFrames,
      staleFrames: log.staleFrames,
      ledgerRefusals: log.ledgerRefusals,
      fragmentsRefused: log.fragmentsRefused,
      kills: log.kills,
      cascadeUnavailable: log.cascadeUnavailable,
    },
    backchannel,
    correction,
    silence,
    booking,
    verdict,
    pass: verdict.every((v) => v.ok) && !wire.error,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// OUTPUT
// ════════════════════════════════════════════════════════════════════════════
function printScorecard(s) {
  const line = (k, v) => out(`  ${String(k).padEnd(30)} ${v}`);
  out('');
  out(`──── ${s.name} — ${s.title}`);
  out('');
  if (s.error) out(`  !! CALL ERROR: ${s.error}`);
  line('call', s.callId);
  line('duration / graph', `${Math.round(s.wire.durationMs / 1000)}s · ${s.wire.graphActions.join(' → ') || 'none'}`);
  line('brain / chain', s.record ? `${s.record.mode} · ${s.record.providers?.stt} → ${s.record.providers?.llm} → ${s.record.providers?.tts}` : 'NO CALL RECORD FOUND');
  line('greeting (felt / record)', `${ms(s.wire.greetingMs)} / ${ms(s.record?.greeting)} (${s.record?.greetingSource || 'n/a'})`);
  out('');
  out('  REPLIES PER UTTERANCE  (from the app\'s own [rtp-out] src= lines)');
  line('utterances played', String(s.wire.utterancesPlayed));
  line('utterances answered', String(s.log.answeredUtterances));
  line('reply runs', String(s.log.replyRuns));
  line('max replies / utterance', String(s.log.maxRepliesPerUtterance));
  line('DOUBLE REPLIES', s.log.doubles.length ? `!! ${JSON.stringify(s.log.doubles)}` : 'none');
  line('frames by source', JSON.stringify(s.log.bySrc));
  line('spec / stale frames', `${s.log.specFrames} / ${s.log.staleFrames}`);
  line('ledger refusals', String(s.log.ledgerRefusals));
  out('');
  out('  FELT LATENCY  (first_audio_ms, off the record\'s waterfalls)');
  line('turns measured', String(s.felt.samples.length));
  line('median / p95 / worst', `${ms(s.felt.median)} / ${ms(s.felt.p95)} / ${ms(s.felt.worst)}`);
  line('per turn', s.felt.samples.length ? s.felt.samples.map((v) => Math.round(v)).join(', ') : 'n/a');
  if (s.backchannel.tested) {
    out('');
    out('  BACKCHANNEL IMMUNITY');
    line('survived', yn(s.backchannel.survived));
    line('kept speaking for', ms(s.backchannel.continuedMs));
    line('barge kills in window', String(s.backchannel.kills));
    for (const l of s.backchannel.ignoredLines) line('', l);
  }
  if (s.correction.tested) {
    out('');
    out('  CORRECTION (must interrupt)');
    line('stopped the agent', yn(s.correction.stopped));
    line('quiet after', ms(s.correction.stopMs));
    line('kills', `${s.correction.kills} ${s.correction.killReasons.join(',')}`);
  }
  if (s.silence.tested) {
    out('');
    out('  SILENCE LADDER');
    line('agent utterances', String(s.silence.utterancesWhileQuiet));
    line('check-in / goodbye at', `${ms(s.silence.firstAtMs)} / ${ms(s.silence.secondAtMs)}`);
    line('terminated at', ms(s.silence.terminateAtMs));
  }
  if (s.booking.booked != null) {
    out('');
    out('  BOOKING');
    line('reference', s.booking.ref || 'NONE');
    line('specialty', `${s.booking.appt?.specialtyLabel ?? 'n/a'} (${yn(s.booking.specialtyOk)})`);
    line('when', `${s.booking.weekday ?? 'n/a'} ${s.booking.when ?? ''} (day ${yn(s.booking.dayOk)}, morning ${yn(s.booking.timeOk)})`);
    line('name / contact', `${s.booking.patientName ?? 'n/a'} / ${s.booking.contact ?? 'n/a'}`);
  }
  out('');
  out('  TRANSCRIPT');
  for (const t of s.transcript) out(`    ${t.who === 'agent' ? 'AGENT ' : 'CALLER'}  ${t.text}`);
  if (!s.transcript.length) out('    (empty — the agent recorded no turns)');
  out('');
  out('  VERDICT');
  for (const v of s.verdict) line(v.ok ? `PASS  ${v.label}` : `FAIL  ${v.label}`, v.detail);
  out('');
  out(`  ${s.pass ? '✔ SCENARIO PASS' : '✘ SCENARIO FAIL'}`);
}

const REPORT_HEADER = `# V8 self-test — the agent, called by a robot that speaks derja

Appended by \`scripts/call-selftest.js\`. Every section below is one RUN: an
isolated app (real \`createApp\`, temp runtime, ephemeral port, cascade brain,
REAL Gemini + Fish) called over real UDP by an in-process werift peer playing
Fish-synthesized derja, and scored against the V8 acceptance bars in
\`docs/VOICE-AGENT-SPEC.md\` §V8.

The caller is synthetic: it reads flat and never overlaps a syllable the way a
person does. These runs clear the MECHANICAL bars — one reply per utterance,
felt latency, backchannel immunity, a correct booking, a released line — so the
founder's live ear-test is spent on the thing only an ear can score.

`;

function appendReport(runs, meta) {
  const at = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const l = [];
  l.push(`## ${at} — ${runs.length} scenario(s) · ${runs.filter((r) => r.pass).length} passed\n`);
  l.push(`Chain: ${runs[0]?.record ? `${runs[0].record.providers?.stt} → ${runs[0].record.providers?.llm} → ${runs[0].record.providers?.tts}` : 'n/a'} · runtime \`${meta.runtimeDir}\` · caller clips ${meta.clipRows.length} (${meta.synthesized} synthesized, ${meta.cached} cached, ${Math.round(meta.bytes / 1024)} KB)\n`);
  l.push('| scenario | verdict | utt played / answered | max replies/utt | felt p50 / p95 / worst | barge kills | notes |');
  l.push('|---|---|---:|---:|---:|---:|---|');
  for (const r of runs) {
    const notes = [];
    if (r.error) notes.push(`error: ${r.error}`);
    if (r.booking?.ref) notes.push(`booked ${r.booking.ref} (${r.booking.weekday})`);
    if (r.backchannel?.tested) notes.push(`backchannel ${r.backchannel.survived ? 'survived' : 'STOPPED THE AGENT'}`);
    if (r.correction?.tested) notes.push(`correction ${r.correction.stopped ? `stopped it in ${ms(r.correction.stopMs)}` : 'DID NOT STOP IT'}`);
    if (r.silence?.tested) notes.push(`silence: ${r.silence.utterancesWhileQuiet} utterance(s), terminated ${yn(r.silence.terminated)}`);
    l.push(
      `| \`${r.name}\` | ${r.pass ? 'PASS' : 'FAIL'} | ${r.wire.utterancesPlayed} / ${r.log.answeredUtterances} | ${r.log.maxRepliesPerUtterance} ` +
        `| ${ms(r.felt.median)} / ${ms(r.felt.p95)} / ${ms(r.felt.worst)} | ${r.log.kills.length} | ${notes.join('; ') || '—'} |`
    );
  }
  l.push('');
  for (const r of runs) {
    l.push(`### ${r.name} — ${r.title}`);
    l.push('');
    l.push('```');
    for (const v of r.verdict) l.push(`${v.ok ? 'PASS' : 'FAIL'}  ${v.label.padEnd(34)} ${v.detail}`);
    l.push('```');
    l.push('');
    l.push('Transcript:');
    l.push('');
    l.push('```');
    for (const t of r.transcript) l.push(`${t.who === 'agent' ? 'AGENT ' : 'CALLER'}  ${t.text}`);
    if (!r.transcript.length) l.push('(empty)');
    l.push('```');
    l.push('');
  }
  const body = `${l.join('\n')}\n`;
  if (!existsSync(REPORT_FILE)) writeFileSync(REPORT_FILE, REPORT_HEADER);
  appendFileSync(REPORT_FILE, body);
  return REPORT_FILE;
}

// ════════════════════════════════════════════════════════════════════════════
// CLEANUP — a self-test that leaks a UDP socket or a listener has failed
// ════════════════════════════════════════════════════════════════════════════
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(600, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  const wanted = String(args.scenario || 'booking').toLowerCase();
  const names = wanted === 'all' ? SCENARIO_ORDER.slice() : [wanted];
  for (const n of names) {
    if (!SCENARIOS[n]) {
      out(`unknown --scenario ${JSON.stringify(n)} — one of: ${SCENARIO_ORDER.join(', ')}, all`);
      process.exit(2);
    }
  }

  const { getConfig } = await import('../src/config.js');
  const { createApp } = await import('../src/server.js');
  const { createBus } = await import('../src/events/bus.js');
  const { warmMediaStack } = await import('../src/voice-call/media.js');
  const { createCodecBridge } = await import('../src/voice-call/brain/codec.js');
  const { ensureClips, CALLER_RATE, CALLER_LINES } = await import('./selftest-voice.js');

  const geminiKey = process.env.GEMINI_API_KEY || '';
  const fishKey = process.env.FISH_AUDIO_API || '';
  if (!geminiKey) {
    out('GEMINI_API_KEY is not set — the cascade has no ears and no brain. Stopping.');
    process.exit(2);
  }
  if (!fishKey) {
    out('FISH_AUDIO_API is not set — the agent has no mouth and the caller has no voice. Stopping.');
    process.exit(2);
  }

  // ── 1. THE CALLER'S VOICE ────────────────────────────────────────────────
  out(`[selftest] synthesizing the caller (${CALLER_RATE} Hz, cache: ${path.relative(ROOT, VOICE_DIR)})`);
  mkdirSync(VOICE_DIR, { recursive: true });
  const keys = clipsNeeded(names);
  const voice = await ensureClips({
    apiKey: fishKey,
    dir: VOICE_DIR,
    keys,
    offline: args['skip-synthesis'] === true,
    log: (m) => out(`  ${m}`),
  });
  if (voice.missing.length) {
    out(`[selftest] --skip-synthesis, but these clips are not cached: ${voice.missing.join(', ')}`);
    process.exit(2);
  }
  for (const r of voice.rows) {
    out(`  ${r.key.padEnd(10)} ${String(r.ms).padStart(5)}ms  ${String(r.samples * 2).padStart(7)}B  ${r.source.padEnd(5)}  «${r.text}»`);
  }
  out(`[selftest] ${voice.rows.length} clip(s): ${voice.synthesized} synthesized, ${voice.cached} cached, ${Math.round(voice.bytes / 1024)} KB total`);

  // ── 2. THE ISOLATED APP ──────────────────────────────────────────────────
  const runtimeDir = path.join(os.tmpdir(), `omen-v8-selftest-${randomUUID()}`);
  mkdirSync(runtimeDir, { recursive: true });
  const config = getConfig({
    runtimeDir,
    mediaDir: path.join(runtimeDir, 'media'),
    sessionSecret: `selftest-${randomUUID()}`,
    cookieSecure: false,
    logRequests: false,
    // Nothing leaves for Meta: the WhatsApp sender is mocked (the degrade
    // follow-up lands in the temp outbox), and the Graph "calls" endpoint is our
    // own stub on loopback.
    whatsappTransport: 'mock',
    appSecret: '', // no HMAC on our own synthetic webhooks
    voiceCalls: true,
    voiceCallMode: 'brain',
    voiceBrain: 'cascade',
    voiceCallTransport: 'real',
    voiceCallGraphBase: `http://127.0.0.1:${GRAPH_PORT}`,
    // REAL keys — this is the self-test, network is sanctioned. Deepgram and
    // Speechmatics are pinned empty so the run cannot silently depend on a key
    // the founder's laptop has and the VPS does not: liveEars is what the
    // Monday demo will actually run on.
    geminiApiKey: geminiKey,
    fishAudioApi: fishKey,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
    speechmaticsApiKey: process.env.SPEECHMATICS_API_KEY || '',
    // The CALL is the subject; the chat engine stays deterministic so a stray
    // Gemini text call cannot steal quota from the brain under test.
    conversationMode: 'classic',
    anthropicApiKey: '',
    // Isolation, the same three ways test-helpers/client.js pins them.
    databaseUrl: '',
    store: '',
    remindersIntervalMs: 0,
    followupsIntervalMs: 0,
  });

  const stub = await startGraphStub(GRAPH_PORT);
  const bus = createBus();
  startCapture();
  const composed = createApp({ config, bus });
  await composed.kbReady;
  const server = await new Promise((resolve) => {
    const s = composed.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const appPort = server.address().port;
  const appBase = `http://127.0.0.1:${appPort}`;

  // THE 24/7 OVERRIDE, on the ISOLATED store only. The JSON adapter reads
  // data/clinics.json once as a read-only seed and hands out that live object;
  // nothing writes it back (src/store/adapters/json/index.js). So this changes
  // THIS process's view of the tenant and no file on disk. A closed clinic
  // rejects every call by design, which would make a 03:00 rehearsal look like
  // a broken brain.
  const clinic = composed.store.getClinicById('el-amen-sousse');
  if (!clinic) throw new Error('el-amen-sousse is not in data/clinics.json');
  const previousHours = clinic.workingHours;
  clinic.workingHours = Object.fromEntries(
    ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, ['00:00', '23:59']])
  );
  const pnid = String(args.pnid || clinic.whatsapp?.phoneNumberId || '');

  warmMediaStack();
  stopCapture();
  out('');
  out(`[selftest] app on ${appBase} · graph stub on :${GRAPH_PORT} · runtime ${runtimeDir}`);
  out(`[selftest] tenant ${clinic.id} (${pnid}) forced open 24/7 in the isolated store only`);
  out(`[selftest] scenarios: ${names.join(', ')}`);
  startCapture();

  // ── 3. RUN ───────────────────────────────────────────────────────────────
  const results = [];
  let werift = null;
  try {
    werift = await import('werift');
  } catch (err) {
    stopCapture();
    out(`[selftest] werift failed to load: ${err?.message || err}`);
    process.exit(1);
  }

  for (const name of names) {
    const scenario = SCENARIOS[name];
    const from = Date.now();
    stopCapture();
    out(`\n[selftest] ▶ ${name} — ${scenario.title}`);
    startCapture();
    const wire = await placeCall({
      werift,
      name,
      scenario,
      clips: voice.clips,
      callerRate: CALLER_RATE,
      appBase,
      pnid,
      createCodecBridge,
    });
    // Let the service drain: the terminate webhook is answered before finish()
    // has written the call record.
    await composed.voiceCalls?.settled?.();
    await sleep(600);
    const record = await readCallRecord(runtimeDir, wire.callId);
    const to = Date.now() + 1;
    results.push(
      scoreCall({
        wire,
        record,
        appointments: readAppointments(runtimeDir),
        lines: linesBetween(from, to),
        scenario,
      })
    );
    if (wire.fatal) {
      stopCapture();
      out('[selftest] aborting: that is a setup problem, not a slow brain.');
      startCapture();
      break;
    }
    if (name !== names[names.length - 1]) await sleep(2000);
  }

  // ── 4. TEARDOWN ──────────────────────────────────────────────────────────
  clinic.workingHours = previousHours; // in-memory only; belt and braces
  await composed.voiceCalls?.stop?.().catch?.(() => {});
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  stopCapture();

  const stillAppPort = await portOpen(appPort);
  const stillGraphPort = await portOpen(GRAPH_PORT);
  let runtimeRemoved = false;
  if (!KEEP_RUNTIME) {
    try {
      rmSync(runtimeDir, { recursive: true, force: true });
      runtimeRemoved = !existsSync(runtimeDir);
    } catch {
      runtimeRemoved = false;
    }
  }

  // ── 5. REPORT ────────────────────────────────────────────────────────────
  for (const r of results) printScorecard(r);

  out('');
  out('════ V8 SELF-TEST — RUN VERDICT ════');
  out('');
  for (const r of results) out(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(14)} ${r.title}`);
  out('');
  out(`  process faults           ${processFaults.length ? `!! ${processFaults.map((f) => f.kind).join(', ')}` : 'none'}`);
  out(`  app port ${String(appPort).padEnd(6)}         ${stillAppPort ? '!! STILL LISTENING' : 'closed'}`);
  out(`  graph port ${String(GRAPH_PORT).padEnd(4)}         ${stillGraphPort ? '!! STILL LISTENING' : 'closed'}`);
  out(`  temp runtime             ${KEEP_RUNTIME ? `kept at ${runtimeDir}` : runtimeRemoved ? 'removed' : `!! NOT REMOVED (${runtimeDir})`}`);

  const allPass = results.length > 0 && results.every((r) => r.pass) && !stillAppPort && !stillGraphPort && processFaults.length === 0;
  out('');
  out(`  ${allPass ? '✔ GO — every V8 bar this run exercised is green' : '✘ NO-GO — see the FAIL lines above'}`);
  out('');

  if (WRITE && results.length) {
    const file = appendReport(results, { runtimeDir, ...voice, clipRows: voice.rows });
    out(`  appended → ${path.relative(ROOT, file)}`);
  }

  // Give any unref'd timer a tick to settle, then leave nothing behind.
  await sleep(200);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  stopCapture();
  console.error('[selftest] fatal:', err?.stack || err);
  process.exit(1);
});
