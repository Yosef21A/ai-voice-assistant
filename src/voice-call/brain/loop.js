// ONE call, end to end: RTP in → brain → RTP out, with the guardrails wired
// where they cannot be talked around.
//
//                     ┌──────────────── emergency preflight (OUR detector) ───┐
//                     │                                                       ▼
//   caller RTP ─▶ codec.decodeIn ─▶ live.sendAudioChunk ─▶ Gemini ─▶ 'audio' ─▶ codec.encodeOut
//                                                             │                      │
//                                                       'toolCall'            paced 20 ms queue
//                                                             ▼                      ▼
//                                                   tools.exec (the gate)      media.sendRtp
//
// The five things this file is actually responsible for:
//
//  1. PACING. Gemini emits audio in bursts; a phone line wants one 20 ms frame
//     every 20 ms. The queue plus a single interval is the jitter buffer. RTP
//     sequence numbers and timestamps advance monotonically across the whole
//     call — werift's sender adds its own offsets to whatever we set, so these
//     are not decoration (rtpSender.sendRtp, werift 0.24.2).
//  2. BARGE-IN. `interrupted` means the caller started talking over us; the
//     queue is dropped on the spot, including the codec's partial frame. There
//     is EXACTLY ONE exception, and it was found by adversarial review: once the
//     emergency script has been dictated, barge-in is ignored and the caller's
//     uplink is muted. Talking over a patient is rude; being interrupted out of
//     saying "call an ambulance on 1 9 0" is dangerous.
//  3. THE EMERGENCY PREFLIGHT. Every fragment of the CALLER's transcription goes
//     through our own deterministic detector, exactly as ingest.js does for
//     messages. On a hit we dictate the exact localized script (a SPOKEN variant
//     — no emoji, digits read out), alert the owner, pause the conversation for
//     humans, put the number in WRITING on WhatsApp (nobody in distress retains
//     a number heard once), and hang up on a grace timer. The model is told to
//     comply; the hang-up does not depend on it complying.
//  4. THE TOOL GATE. Function calls are executed by ./tools.js — the only path
//     to a database write. This module feeds that gate the two facts it cannot
//     observe for itself: which tool BATCH we are in, and when the caller last
//     spoke. Without them a single stage+confirm batch books an appointment the
//     caller never heard about (reproduced: CX-260803-001).
//  5. THE DEGRADE. goAway / error / close ⇒ outcome 'brain_lost'. The loop does
//     NOT hang up the call itself: it reports, and the service terminates and
//     sends the WhatsApp follow-up so the existing chat engine takes over. That
//     handover is the difference between an outage and a lost patient.
//
// Nothing here throws into the RTP path or into a WebSocket handler.
import { createCodecBridge } from './codec.js';
import { createLiveClient } from './liveClient.js';
import { buildVoiceSystemPrompt } from './prompts.js';
import { buildToolDeclarations, createToolExecutor } from './tools.js';
import { detectEmergency } from '../../notifications/detector.js';
import { buildEmergencyReply, buildSpokenEmergencyReply } from '../../notifications/pipeline.js';
import { isFacilitator } from '../../engine/tenantProfile.js';
// The chat engine's own "what time is it" string. Imported, not re-implemented:
// two channels disagreeing about today's date is a bug nobody looks for until a
// patient is booked on the wrong day.
import { nowString } from '../../engine/humanize/context.js';
import { sendAs } from '../../api/outbound.js';

const LANG_NAME = { ar: 'Arabic', fr: 'French', en: 'English' };
const FRAME_MS = 20;
/** Rolling window of ONE uninterrupted caller utterance the detector sees. */
const EMERGENCY_WINDOW_CHARS = 200;
/** Hard cap on the stored transcript (tail kept — the end of a call matters most). */
const TRANSCRIPT_MAX_CHARS = 8000;
// Long enough for the full Arabic script, which is the longest of the three and
// is read slowly on purpose. 9s truncated it mid-number in review.
const DEFAULT_EMERGENCY_GRACE_MS = 12000;
/** RFC 4733 event codes → the key the caller pressed. */
const DTMF_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#', 'A', 'B', 'C', 'D'];

const rand32 = () => Math.floor(Math.random() * 0xffffffff) >>> 0;
const rand16 = () => Math.floor(Math.random() * 0xffff) & 0xffff;

function toDate(v) {
  return v instanceof Date ? v : new Date(Number(v) || Date.now());
}

/**
 * @param {object} p
 * @param {object} p.clinic
 * @param {object} p.convo          conversation record ({ id, patientWaId })
 * @param {object} p.media          the media session (sdpAnswer + sendRtp)
 * @param {object} p.store
 * @param {object} p.bus
 * @param {object} p.sender         the ONE WhatsApp sender
 * @param {object} p.config
 * @param {string} [p.lang]
 * @param {string} [p.patientWaId]
 * @param {string} [p.sdpOffer]     Meta's offer (codec fallback)
 * @param {Function} [p.liveFactory] default createLiveClient — tests inject
 * @param {Function} [p.now]
 * @param {Function} [p.logger]
 * @param {Function} [p.onEnd]      called ONCE with the outcome when the loop stops
 */
export function createBrainLoop({
  clinic,
  convo,
  media,
  store,
  bus,
  sender,
  config = {},
  lang = 'ar',
  patientWaId: waIdOverride,
  sdpOffer,
  liveFactory,
  now,
  logger,
  onEnd,
} = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const log = typeof logger === 'function' ? logger : (...a) => console.error(...a);
  const makeLive = typeof liveFactory === 'function' ? liveFactory : createLiveClient;
  const L = ['ar', 'fr', 'en'].includes(lang) ? lang : 'ar';

  const tenantId = clinic?.id ?? null;
  const conversationId = convo?.id ?? null;
  // JSON stores `waId`, Postgres stores `patientWaId` — read both, and prefer
  // the caller id the webhook actually gave us (see tools.js for the full note).
  const patientWaId = waIdOverride ?? convo?.patientWaId ?? convo?.waId ?? null;
  const graceMs = Number(config.voiceBrainEmergencyGraceMs) || DEFAULT_EMERGENCY_GRACE_MS;
  const facilitator = isFacilitator(clinic);

  /**
   * Per-call mutable state. `toolBatchId`, `lastCallerSpeechAt` and
   * `speechSinceStage` are maintained HERE and read by the tool executor — they
   * are the evidence the booking gate checks (see tools.js confirm_booking).
   */
  const callState = {
    staged: null,
    booked: null,
    appointment: null,
    handoff: false,
    emergency: false,
    lead: null,
    toolBatchId: 0,
    lastCallerSpeechAt: 0,
    speechSinceStage: '',
  };
  const transcript = [];
  const cancelledToolIds = new Set();
  const toolNamesById = new Map();
  const pending = new Set();

  let codec = null;
  let live = null;
  let executor = null;
  let started = false;
  let stopped = false;
  let outcomeReason = null;
  let toolCalls = 0;

  // Outbound pacing.
  let outQueue = [];
  let paceTimer = null;
  let emergencyTimer = null;
  let seq = rand16();
  let rtpTs = rand32();
  const ssrc = rand32();
  let markNext = true; // RTP marker bit on the first packet after a silence

  let emergencyWindow = '';
  let callerHasFloor = false; // true between a caller fragment and our reply
  let dtmfActive = null;

  function track(p) {
    const q = Promise.resolve(p).catch((err) => log('[voice-brain] background task failed:', err?.message || err));
    pending.add(q);
    q.finally(() => pending.delete(q));
    return q;
  }

  async function settled() {
    for (let i = 0; i < 20 && pending.size; i += 1) await Promise.all([...pending]);
  }

  // ── transcript ─────────────────────────────────────────────────────────────
  function appendTranscript(who, text) {
    const s = String(text || '');
    if (!s) return;
    const last = transcript[transcript.length - 1];
    // Gemini streams transcription in fragments. Merging consecutive fragments
    // from one speaker VERBATIM is what makes the inbox row readable instead of
    // confetti — and injecting a separator would split words mid-token.
    if (last && last.who === who) last.text += s;
    else transcript.push({ who, text: s, at: toDate(clock()).toISOString() });

    let total = 0;
    for (const e of transcript) total += e.text.length;
    while (total > TRANSCRIPT_MAX_CHARS && transcript.length) {
      const head = transcript[0];
      const over = total - TRANSCRIPT_MAX_CHARS;
      if (head.text.length > over) {
        head.text = head.text.slice(over);
        total -= over;
      } else {
        total -= head.text.length;
        transcript.shift();
      }
    }
  }

  // ── outbound RTP ───────────────────────────────────────────────────────────
  // werift's MediaStreamTrack.writeRtp() accepts a serialized packet Buffer and
  // deserializes it itself (werift 0.24.2, media/track.js), so the brain builds
  // a plain 12-byte RTP header rather than importing the WebRTC stack a second
  // time. Fewer moving parts, and the loop stays unit-testable with no werift.
  function buildRtpPacket(payload) {
    const header = Buffer.allocUnsafe(12);
    header[0] = 0x80; // V=2, no padding, no extension, CC=0
    header[1] = (markNext ? 0x80 : 0x00) | (codec.payloadType & 0x7f);
    header.writeUInt16BE(seq, 2);
    header.writeUInt32BE(rtpTs >>> 0, 4);
    header.writeUInt32BE(ssrc >>> 0, 8);
    seq = (seq + 1) & 0xffff;
    markNext = false;
    return Buffer.concat([header, Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
  }

  function tick() {
    if (stopped || !codec) return;
    // The clock advances whether or not we speak — that is what RTP timestamps
    // mean, and a receiver uses the gap to know silence happened.
    rtpTs = (rtpTs + codec.timestampIncrement) >>> 0;
    if (!outQueue.length) {
      markNext = true;
      return;
    }
    const payload = outQueue.shift();
    try {
      media?.sendRtp?.(buildRtpPacket(payload));
    } catch (err) {
      log('[voice-brain] sendRtp failed:', err?.message || err);
    }
  }

  function ensurePacing() {
    if (paceTimer || stopped) return;
    paceTimer = setInterval(tick, FRAME_MS);
    if (typeof paceTimer.unref === 'function') paceTimer.unref();
  }

  /** Barge-in: drop everything we were about to say, mid-sentence. */
  function flushOutbound() {
    outQueue = [];
    markNext = true;
    codec?.resetOut();
  }

  // ── emergency preflight (the model never gets a vote) ──────────────────────
  function onPatientSpeech(text) {
    appendTranscript('patient', text);
    // The booking gate needs to know the caller answered. Both facts are read
    // by tools.js confirm_booking; neither is observable from inside a tool.
    callState.lastCallerSpeechAt = toDate(clock()).getTime();
    if (callState.staged) callState.speechSinceStage += String(text || '');

    if (callState.emergency) return;
    // THE WINDOW IS ONE UTTERANCE, NOT ONE CALL. It exists only to rejoin
    // fragments Gemini streams mid-sentence ("عندي " + "وجع " + "في " + "صدري").
    // Letting it span turns produced a proven false positive: "وجع في ركبتي"
    // (knee) one turn, "تصوير الصدر" (chest imaging) the next → chest_pain
    // fires, ambulance script, call terminated — on a routine booking call.
    // It is reset the moment the AGENT takes the floor (see onAgentTurn).
    callerHasFloor = true;
    emergencyWindow = `${emergencyWindow}${text}`.slice(-EMERGENCY_WINDOW_CHARS);
    const hit = detectEmergency(emergencyWindow, L);
    if (!hit.hit) return;
    callState.emergency = true;
    track(fireEmergency(hit));
  }

  /** The agent is speaking ⇒ the caller's utterance is over. */
  function onAgentTurn() {
    if (!callerHasFloor) return;
    callerHasFloor = false;
    emergencyWindow = '';
  }

  async function fireEmergency(hit) {
    // Localize from the table that MATCHED, not the ambient guess — same rule as
    // notifications/pipeline.js. Arabizi is Arabic typed in Latin ⇒ Arabic reply.
    const matched = hit.lang === 'arabizi' ? 'ar' : hit.lang;
    const replyLang = ['ar', 'fr', 'en'].includes(matched) ? matched : L;
    const spoken = buildSpokenEmergencyReply(clinic, replyLang); // no emoji, digits read out
    const written = buildEmergencyReply(clinic, replyLang); // the WhatsApp copy

    // 1) The caller's EAR first. Flush whatever we were saying so the override
    //    is not queued behind a sentence about opening hours. This is the LAST
    //    flush of the call: from here `interrupted` is ignored and the uplink is
    //    muted, so nothing can cut the script short.
    flushOutbound();
    try {
      live?.sendText(
        `[SYSTEM] EMERGENCY OVERRIDE — this is not from the caller. Say the following out loud now, in full, exactly as written, then STOP TALKING and add nothing at all: ${spoken}`
      );
    } catch (err) {
      log('[voice-brain] emergency script dispatch failed:', err?.message || err);
    }

    // 2) Staff.
    try {
      bus?.publish?.('emergency.detected', {
        tenantId,
        conversationId,
        keyword: hit.keyword,
        category: hit.category,
        lang: hit.lang || L,
        waId: patientWaId,
        patientWaId,
        channel: 'call',
      });
    } catch (err) {
      log('[voice-brain] emergency publish failed:', err?.message || err);
    }

    // 3) The bot steps back on EVERY channel, not just this call.
    try {
      if (conversationId) {
        const patch = { status: 'needs_human', aiPaused: true };
        await store.conversations.update(tenantId, conversationId, patch);
        bus?.publish?.('conversation.updated', { tenantId, conversationId, patch });
      }
    } catch (err) {
      log('[voice-brain] emergency pause failed:', err?.message || err);
    }

    // 4) IN WRITING. Nobody in distress retains a phone number heard once.
    try {
      if (conversationId && patientWaId) {
        await sendAs('bot', conversationId, () => sender.sendText(clinic, patientWaId, written));
      }
    } catch (err) {
      log('[voice-brain] emergency WhatsApp text failed:', err?.message || err);
    }

    // 5) End the call — on a timer, so it happens whether or not the model obeyed.
    if (!stopped && !emergencyTimer) {
      emergencyTimer = setTimeout(() => stop('emergency'), graceMs);
      if (typeof emergencyTimer.unref === 'function') emergencyTimer.unref();
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────────
  async function onToolCall(calls) {
    // One increment per BATCH. tools.js refuses a confirm whose stage carries
    // this same id — that is the "you have not read the recap yet" check.
    callState.toolBatchId += 1;
    const responses = [];
    for (const c of calls || []) {
      if (c.id) toolNamesById.set(c.id, c.name);
      if (c.id && cancelledToolIds.has(c.id)) continue;
      toolCalls += 1;
      const result = await executor.exec({ name: c.name, args: c.args });
      if (c.id && cancelledToolIds.has(c.id)) continue; // cancelled while running
      responses.push({ id: c.id, name: c.name, response: { result } });
    }
    if (responses.length && !stopped) live?.sendToolResponse(responses);
  }

  function onToolCancellation(ids) {
    for (const id of ids || []) {
      cancelledToolIds.add(id);
      // A staged booking whose staging was cancelled must not stay confirmable:
      // that is precisely the hole the multi-condition gate exists to close.
      if (toolNamesById.get(id) === 'stage_booking') callState.staged = null;
    }
  }

  // ── DTMF (noisy lines, RFC 4733) ───────────────────────────────────────────
  function handleDtmf(payload) {
    if (!payload || payload.length < 4) return;
    const digit = DTMF_DIGITS[payload[0]];
    if (digit == null) return;
    const end = (payload[1] & 0x80) !== 0;
    if (end) {
      dtmfActive = null;
      return;
    }
    if (dtmfActive === digit) return; // the event repeats every 20 ms while held
    dtmfActive = digit;
    if (digit === '1') {
      // An agency has no calendar — offering "press 1 to book" there would be a
      // promise it cannot keep, so 1 starts QUALIFICATION instead.
      live?.sendText(
        facilitator
          ? '[SYSTEM] The caller pressed 1 on the keypad: they want help finding a clinic. Start the qualification questions now — ask what treatment they need first.'
          : '[SYSTEM] The caller pressed 1 on the keypad: they want to book an appointment. Start the booking flow now and ask for the first missing detail.'
      );
    } else if (digit === '2') {
      track(
        (async () => {
          await executor.exec({ name: 'request_handoff', args: { reason: 'dtmf_2' } });
          live?.sendText(
            '[SYSTEM] The caller pressed 2 on the keypad: they asked for a human. Tell them a team member will follow up on WhatsApp in this same conversation, say a warm goodbye, and stop.'
          );
        })()
      );
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────────
  // Every handler re-checks `stopped`. Frames can land after the call is over —
  // a WebSocket close is not instantaneous — and driving a stopped loop means a
  // tool call against a torn-down store or a transcript entry written after the
  // conversation row was already persisted.
  function wire() {
    live.on('audio', (pcm24) => {
      if (stopped) return;
      onAgentTurn();
      try {
        for (const payload of codec.encodeOut(pcm24)) outQueue.push(payload);
        ensurePacing();
      } catch (err) {
        log('[voice-brain] outbound encode failed:', err?.message || err);
      }
    });
    live.on('interrupted', () => {
      if (stopped) return;
      // THE ONE EXCEPTION. After the emergency script is dictated we keep
      // talking over the caller deliberately: being interrupted out of reading
      // an ambulance number is a worse outcome than being rude.
      if (callState.emergency) return;
      flushOutbound();
    });
    live.on('inputTranscription', (text) => {
      if (stopped) return;
      onPatientSpeech(text);
    });
    live.on('outputTranscription', (text) => {
      if (stopped) return;
      onAgentTurn();
      appendTranscript('agent', text);
    });
    live.on('turnComplete', () => onAgentTurn());
    live.on('toolCall', (calls) => {
      if (stopped) return;
      track(onToolCall(calls));
    });
    live.on('toolCallCancellation', (ids) => {
      if (stopped) return;
      onToolCancellation(ids);
    });
    live.on('goAway', (info) => {
      log('[voice-brain] live session going away:', JSON.stringify(info || {}));
      if (!stopped) stop('brain_lost');
    });
    live.on('error', (err) => {
      log('[voice-brain] live error:', err?.message || err);
      if (!stopped) stop('brain_lost');
    });
    live.on('close', () => {
      if (!stopped) stop('brain_lost');
    });
  }

  function greetingInstruction() {
    const who = clinic?.name || 'the clinic';
    return `[SYSTEM] The call has just connected and the caller is listening. Greet them now in ${LANG_NAME[L]}: one short warm sentence that names "${who}", says you are an automated assistant, and asks how you can help. Do not list services. Then stop and wait.`;
  }


  return {
    /**
     * Build the codec, open the brain, and make the agent speak FIRST — a
     * silent line after "hello?" is how a caller decides you are broken.
     * Rejects when the brain never came up; the service degrades on that.
     */
    async start() {
      if (started) return;
      started = true;
      codec = createCodecBridge({ sdpAnswer: media?.sdpAnswer, sdpOffer, logger: log });
      executor = createToolExecutor({
        clinic,
        convo,
        store,
        bus,
        callState,
        lang: L,
        patientWaId,
        now: clock,
        logger: log,
      });
      live = makeLive({
        apiKey: config.geminiApiKey,
        model: config.geminiLiveModel,
        systemInstruction: buildVoiceSystemPrompt({
          clinic,
          lang: L,
          nowStr: nowString(toDate(clock())),
        }),
        tools: buildToolDeclarations({ clinic }),
        logger: log,
      });
      wire();
      await live.ready;
      if (stopped) {
        live.close();
        return;
      }
      live.sendText(greetingInstruction());
      ensurePacing();
    },

    /** Wire this into media.onRtp. NEVER throws. */
    onRtp(packet) {
      if (stopped || !packet || !codec) return;
      try {
        const pt = packet.header?.payloadType ?? packet.payloadType ?? null;
        const payload = packet.payload;
        if (!payload || !payload.length) return;
        if (codec.dtmfPayloadType != null && pt === codec.dtmfPayloadType) {
          handleDtmf(payload);
          return;
        }
        // MUTE THE UPLINK once the emergency script is in flight. Gemini's
        // server-side VAD treats incoming audio as a barge-in and will abort
        // generation mid-sentence — so a caller who keeps talking (which is
        // exactly what a frightened caller does) would cut off the ambulance
        // number. Nothing they say now changes what happens next anyway: staff
        // are already paged and the call ends on a timer.
        if (callState.emergency) return;
        const pcm = codec.decodeIn(payload);
        if (pcm.length) live?.sendAudioChunk(pcm);
      } catch (err) {
        log('[voice-brain] inbound RTP handling failed:', err?.message || err);
      }
    },

    /** Idempotent. Returns the final outcome. */
    stop(reason) {
      return stop(reason);
    },

    /** Bounded, speaker-tagged, oldest-first. Safe to persist. */
    transcript() {
      return transcript.map((e) => ({ who: e.who, text: e.text, at: e.at }));
    },

    outcome: buildOutcome,

    /** Ops + tests: drain the out-of-band work (tool calls, emergency writes). */
    settled,

    /** Test/ops visibility only — never used to make a decision. */
    stats() {
      return {
        outQueue: outQueue.length,
        pacing: !!paceTimer,
        codec: codec ? codec.stats() : null,
        live: live ? live.stats() : null,
        staged: !!callState.staged,
        toolBatchId: callState.toolBatchId,
        emergencyWindow,
      };
    },
  };

  /** The single record every consumer reads: transcript row, bus, ops. */
  function buildOutcome() {
    return {
      reason: outcomeReason,
      booked: callState.booked || null,
      handoff: !!callState.handoff,
      emergency: !!callState.emergency,
      lead: callState.lead ? { ...callState.lead } : null,
      turns: transcript.length,
      toolCalls,
      codec: codec ? codec.codec : null,
    };
  }

  // Idempotent by contract: finish(), the emergency timer, a lost brain and the
  // service's shutdown all race each other, and doing this twice must be free.
  function stop(reason) {
    if (stopped) return buildOutcome();
    stopped = true;
    outcomeReason = outcomeReason || reason || 'stopped';
    if (paceTimer) {
      clearInterval(paceTimer);
      paceTimer = null;
    }
    if (emergencyTimer) {
      clearTimeout(emergencyTimer);
      emergencyTimer = null;
    }
    outQueue = [];
    try {
      live?.close();
    } catch {
      /* close() is contractually non-throwing; belt and braces */
    }
    try {
      codec?.close();
    } catch {
      /* same */
    }
    const oc = buildOutcome();
    if (typeof onEnd === 'function') {
      try {
        onEnd(oc);
      } catch (err) {
        log('[voice-brain] onEnd handler threw:', err?.message || err);
      }
    }
    return oc;
  }
}

export default createBrainLoop;
