// WebRTC media plane for inbound WhatsApp calls (V1) — a thin, boring wrapper
// around werift so the rest of the codebase never imports a WebRTC type.
//
// V1 scope is SIGNALING + MEDIA ECHO. There is no STT, no LLM, no TTS here: this
// module hands raw inbound RTP to a callback and lets the caller write RTP back.
// Whatever replaces the echo later (transcribe → engine → synthesize) plugs into
// the SAME two seams, so the socket code below never has to change again.
//
// Facts verified against werift 0.24.2 on this machine (see the media e2e test):
//   • `pc.onTrack` must be subscribed BEFORE `setRemoteDescription` — werift
//     fires it synchronously while applying the remote SDP, and a subscription
//     added afterwards silently receives nothing. This cost a debugging round;
//     it is the single most important line in this file.
//   • `setLocalDescription()` awaits ICE gathering internally, so
//     `pc.localDescription.sdp` already carries `a=candidate` lines (vanilla
//     ICE). REQUIRED: Meta gives us no trickle-ICE channel — the answer we hand
//     to `pre_accept` must be complete on its own.
//   • `track.writeRtp(pkt)` rewrites ssrc / payloadType / sequenceNumber /
//     timestamp to the negotiated sender values, so echoing an inbound packet
//     verbatim is safe (werift rtpSender.sendRtp).
//   • Loopback connect took ~170-220ms; echo round trip median ~1ms.
//
// werift is imported LAZILY (~1s of module evaluation). src/server.js is imported
// by the CLI demo and by every test process; none of them should pay a second of
// startup for a WebRTC stack they will never use. The real server warms it at
// boot (see the run-directly block in server.js) so no live caller ever waits.

let weriftPromise = null;

/** Load (once) and cache the werift module. */
function werift() {
  if (!weriftPromise) weriftPromise = import('werift');
  return weriftPromise;
}

/** Pre-load the WebRTC stack off the critical path. Never throws. */
export async function warmMediaStack() {
  try {
    await werift();
    return true;
  } catch {
    return false;
  }
}

// WhatsApp calls are Opus 48kHz stereo. Pinning the codec list keeps the answer
// SDP small and predictable instead of negotiating whatever werift defaults to.
//
// telephone-event (RFC 4733 DTMF) is in the list since V2, and it is NOT
// cosmetic. An SDP answer may only contain codecs the OFFER carried, and werift
// additionally drops anything not in OUR list — so with opus alone the answer
// stripped telephone-event even when the caller offered it, the negotiated DTMF
// payload type came back null, and the whole keypad fallback was dead code that
// looked alive. Verified against werift 0.24.2: with this entry an offer
// carrying telephone-event answers with it, and an offer WITHOUT it still
// answers opus-only (so the V1 echo path is untouched).
function audioCodecs(RTCRtpCodecParameters) {
  return {
    audio: [
      new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }),
      new RTCRtpCodecParameters({ mimeType: 'audio/telephone-event', clockRate: 8000 }),
    ],
  };
}

/**
 * Answer an inbound SDP offer and open a bidirectional audio path.
 *
 * @param {object} p
 * @param {string} p.sdpOffer        Meta's offer (RFC 8866), from the connect webhook
 * @param {(rtp:object)=>void} [p.onRtp]  called for EVERY inbound RTP packet
 * @param {Function} [p.clockNow]    inject a clock (tests); default Date.now
 * @param {object} [p.peerConfig]    extra werift RTCPeerConnection config.
 *   Notably `{ iceServers: [] }`: werift defaults to Google's public STUN
 *   server, which is right in production (the caller is on the internet) but
 *   makes a loopback test depend on outbound UDP — pass an empty list there.
 * @returns {Promise<{sdpAnswer:string, sendRtp:Function, onConnected:Function,
 *                    close:Function, stats:Function}>}
 */
export async function createMediaSession({ sdpOffer, onRtp, clockNow, peerConfig } = {}) {
  if (!sdpOffer || typeof sdpOffer !== 'string') {
    throw new Error('createMediaSession requires an SDP offer');
  }
  const now = typeof clockNow === 'function' ? clockNow : () => Date.now();
  const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } = await werift();

  const pc = new RTCPeerConnection({
    codecs: audioCodecs(RTCRtpCodecParameters),
    ...(peerConfig || {}),
  });
  const outTrack = new MediaStreamTrack({ kind: 'audio' });

  const state = {
    rtpIn: 0,
    rtpOut: 0,
    firstRtpInAt: null,
    lastRtpInAt: null,
    connectedAt: null,
    closed: false,
  };
  const connectedWaiters = [];

  const markConnected = () => {
    if (state.connectedAt != null || state.closed) return;
    state.connectedAt = now();
    const waiters = connectedWaiters.splice(0, connectedWaiters.length);
    for (const cb of waiters) {
      try {
        cb();
      } catch {
        /* a consumer callback must never break the media plane */
      }
    }
  };

  // ORDER MATTERS — see the header note. Subscribe first, apply the offer second.
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      state.rtpIn += 1;
      const t = now();
      if (state.firstRtpInAt == null) state.firstRtpInAt = t;
      state.lastRtpInAt = t;
      // Audio arriving IS proof the path is up, even if the connection state
      // event was missed — belt and braces on the one signal that matters.
      markConnected();
      if (typeof onRtp === 'function') {
        try {
          onRtp(rtp);
        } catch {
          /* the echo/handler must never kill the socket */
        }
      }
    });
  });

  pc.connectionStateChange.subscribe((s) => {
    if (s === 'connected') markConnected();
  });

  await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
  pc.addTrack(outTrack); // sendrecv: we listen AND we speak
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer); // resolves after ICE gathering completes
  const sdpAnswer = pc.localDescription?.sdp || answer.sdp;

  if (pc.connectionState === 'connected') markConnected();

  return {
    sdpAnswer,

    /** Write one RTP packet toward the caller. Never throws. */
    sendRtp(packet) {
      if (state.closed || !packet) return false;
      try {
        outTrack.writeRtp(packet);
        state.rtpOut += 1;
        return true;
      } catch {
        return false;
      }
    },

    /** Fire `cb` once media is up (immediately if it already is). */
    onConnected(cb) {
      if (typeof cb !== 'function') return;
      if (state.connectedAt != null) {
        try {
          cb();
        } catch {
          /* ignore */
        }
        return;
      }
      connectedWaiters.push(cb);
    },

    /** Idempotent, never throws, leaves no timers behind (we start none). */
    close() {
      if (state.closed) return;
      state.closed = true;
      connectedWaiters.length = 0;
      try {
        outTrack.stop();
      } catch {
        /* best-effort */
      }
      try {
        // werift's close() is async; a rejection here is never actionable.
        Promise.resolve(pc.close()).catch(() => {});
      } catch {
        /* best-effort */
      }
    },

    stats() {
      return {
        rtpIn: state.rtpIn,
        rtpOut: state.rtpOut,
        firstRtpInAt: state.firstRtpInAt,
        lastRtpInAt: state.lastRtpInAt,
        connectedAt: state.connectedAt,
        closed: state.closed,
      };
    },
  };
}

export default createMediaSession;
