// Media plane e2e (V1) — a REAL WebRTC call against createMediaSession().
//
// This is the test that would have caught every mistake we actually made while
// building the media layer, so it uses no fakes at all: a genuine werift peer
// plays the caller (exactly what a phone does — offer, ICE, DTLS-SRTP, RTP),
// createMediaSession() plays the clinic, and the service's V1 echo behaviour is
// reproduced by hand (media.js deliberately does not echo on its own).
//
// What it proves:
//   1. the SDP answer we hand to Meta's `pre_accept` is COMPLETE — vanilla ICE,
//      candidates inline — because Meta gives us no trickle-ICE channel;
//   2. media actually connects;
//   3. audio flows BOTH ways: every packet the caller sends comes back;
//   4. the round trip is fast enough for a conversation.
//
// It binds UDP sockets. On a sandbox that forbids that, it skips cleanly rather
// than failing — but it is expected to RUN, and its numbers are quoted in the
// slice report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader } from 'werift';
import { createMediaSession } from '../src/voice-call/media.js';

const PACKETS = 30; // ≥ 20 required; 30 gives a stabler median
const PACKET_GAP_MS = 20; // one 20ms Opus frame, i.e. real call cadence
const MEDIAN_BUDGET_MS = 1500;

/** Can this environment open a UDP socket at all? */
function canBindUdp() {
  return new Promise((resolve) => {
    let sock;
    try {
      sock = dgram.createSocket('udp4');
    } catch {
      return resolve(false);
    }
    sock.once('error', () => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve(false);
    });
    sock.bind(0, '127.0.0.1', () => {
      sock.close(() => resolve(true));
    });
  });
}

const waitFor = (predicate, { timeoutMs = 15000, label = 'condition' } = {}) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (predicate()) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 10);
    tick.unref?.();
  });

test('real WebRTC: offer → answer → connected → audio echoes back', { timeout: 30000 }, async (t) => {
  if (!(await canBindUdp())) {
    t.skip('environment cannot bind UDP sockets — media e2e needs real sockets');
    return;
  }

  const codecs = {
    audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })],
  };
  // iceServers: [] on BOTH peers. werift defaults to Google's public STUN, which
  // is correct in production but would make this suite depend on outbound UDP to
  // the internet (and stall ~5s per peer when it is blocked). Loopback host
  // candidates are all a 127.0.0.1 call needs.
  const caller = new RTCPeerConnection({ codecs, iceServers: [] });
  const callerTrack = new MediaStreamTrack({ kind: 'audio' });
  let media = null;

  try {
    // ── the caller (a phone) ────────────────────────────────────────────────
    const sentAt = new Map(); // seq → ms
    const latencies = [];
    let echoCount = 0;
    // Subscribe BEFORE any description is applied — werift fires onTrack while
    // applying the remote SDP, and a later subscription silently gets nothing.
    caller.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        echoCount += 1;
        if (rtp.payload && rtp.payload.length >= 2) {
          const seq = rtp.payload.readUInt16BE(0);
          const at = sentAt.get(seq);
          if (at != null) latencies.push(Date.now() - at);
        }
      });
    });
    caller.addTrack(callerTrack);
    await caller.setLocalDescription(await caller.createOffer());
    const offerSdp = caller.localDescription.sdp;

    // ── the clinic (what the voice-call service builds on a connect webhook) ─
    const t0 = Date.now();
    media = await createMediaSession({
      sdpOffer: offerSdp,
      // V1 echo, exactly as src/voice-call/index.js wires it.
      onRtp: (rtp) => media?.sendRtp(rtp),
      peerConfig: { iceServers: [] },
    });

    assert.ok(media.sdpAnswer, 'an SDP answer was produced');
    assert.match(media.sdpAnswer, /^v=0/, 'the answer is a real SDP');
    assert.match(
      media.sdpAnswer,
      /a=candidate/,
      'vanilla ICE: candidates are INLINE — Meta has no trickle channel'
    );
    assert.match(media.sdpAnswer, /m=audio/, 'the answer negotiates audio');

    let connectedFired = false;
    media.onConnected(() => {
      connectedFired = true;
    });

    await caller.setRemoteDescription({ type: 'answer', sdp: media.sdpAnswer });
    await waitFor(() => caller.connectionState === 'connected', { label: 'caller connection' });
    await waitFor(() => media.stats().connectedAt != null, { label: 'media connect callback' });
    const connectMs = Date.now() - t0;
    assert.equal(connectedFired, true, 'onConnected fired for a subscriber registered before connect');

    // Late subscribers must fire immediately, not hang — the service relies on
    // this when media connects before it gets a chance to subscribe.
    let lateFired = false;
    media.onConnected(() => {
      lateFired = true;
    });
    assert.equal(lateFired, true, 'onConnected on an already-connected session fires at once');

    // ── talk ────────────────────────────────────────────────────────────────
    let ts = 0;
    for (let seq = 1; seq <= PACKETS; seq += 1) {
      const payload = Buffer.alloc(20);
      payload.writeUInt16BE(seq, 0); // correlation id, survives the echo verbatim
      sentAt.set(seq, Date.now());
      callerTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({ payloadType: 96, sequenceNumber: seq, timestamp: (ts += 960), ssrc: 424242 }),
          payload
        )
      );
      await new Promise((r) => setTimeout(r, PACKET_GAP_MS));
    }
    await waitFor(() => latencies.length >= 20, { timeoutMs: 5000, label: '20 echoed packets' });

    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)];
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
    console.log(
      `[voice-call media e2e] connect=${connectMs}ms  sent=${PACKETS}  echoed=${echoCount}  ` +
        `latency median=${median}ms p95=${p95}ms max=${latencies[latencies.length - 1]}ms`
    );

    const stats = media.stats();
    assert.ok(stats.rtpIn >= 20, `clinic received RTP (rtpIn=${stats.rtpIn})`);
    assert.ok(stats.rtpOut >= 20, `clinic echoed RTP back (rtpOut=${stats.rtpOut})`);
    assert.ok(stats.firstRtpInAt != null && stats.lastRtpInAt >= stats.firstRtpInAt);
    assert.ok(echoCount >= 20, `the caller heard itself back (${echoCount} packets)`);
    assert.ok(
      median < MEDIAN_BUDGET_MS,
      `echo round trip median ${median}ms must stay under ${MEDIAN_BUDGET_MS}ms`
    );

    // ── teardown contract ───────────────────────────────────────────────────
    media.close();
    media.close(); // idempotent — the watchdog and the terminate webhook race
    assert.equal(media.stats().closed, true);
    assert.equal(media.sendRtp({}), false, 'a closed session refuses to write');
  } finally {
    try {
      media?.close();
    } catch {
      /* close() is contractually non-throwing */
    }
    try {
      await caller.close();
    } catch {
      /* ignore */
    }
  }
});

test('createMediaSession rejects a missing/empty offer without opening anything', async () => {
  await assert.rejects(() => createMediaSession({}), /requires an SDP offer/);
  await assert.rejects(() => createMediaSession({ sdpOffer: '' }), /requires an SDP offer/);
});
