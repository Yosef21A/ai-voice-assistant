// Local WhatsApp-call harness (V1) — call the agent from a browser tab.
//
// WHY: Meta gates the Calling API on an approved number, so the honest way to
// prove the media plane BEFORE that approval lands is to speak Meta's exact
// wire protocol locally. This script is a stand-in for Meta on BOTH sides:
//
//   browser  ──getUserMedia + SDP offer──▶  harness
//   harness  ──POST the EXACT Meta "connect" webhook──▶  the app (/webhook)
//   app      ──POST {version}/{pnid}/calls (pre_accept / accept)──▶  harness
//   browser  ──polls /call/answer, applies the SDP answer──▶  real WebRTC media
//
// You then hear yourself, because V1 echoes RTP back. That round trip is the
// whole point: if your voice comes back, signaling + ICE + DTLS-SRTP + the echo
// loop all work, and only the brain (STT → engine → TTS) is missing.
//
// RUN RECIPE
//   # terminal 1 (the app; WhatsApp sends stay mock, call actions hit the harness):
//   WHATSAPP_TRANSPORT=mock VOICE_CALL_TRANSPORT=real VOICE_CALL_GRAPH_BASE=http://localhost:3901 npm start
//   # terminal 2:
//   node scripts/call-harness.js      → open http://localhost:3901
//
// Nothing here is imported by the app. It is a dev tool, it binds one port, and
// it holds only in-memory state.
import express from 'express';

const PORT = Number(process.env.HARNESS_PORT) || 3901;
const HOST = process.env.HARNESS_HOST || '127.0.0.1';
const APP_WEBHOOK = process.env.APP_WEBHOOK || 'http://localhost:3000/webhook';
// Must match a tenant in data/clinics.json (el-amen-sousse by default).
const PNID = process.env.HARNESS_PNID || '1153135121224452';
const FROM = process.env.HARNESS_FROM || '216HARNESS01';

/** callId → { sdpAnswer, actions[], startedAt, accepted } */
const calls = new Map();

const app = express();
app.use(express.json({ limit: '2mb' }));

// ── the browser side ─────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.type('html').send(PAGE);
});

// Wrap the browser's SDP offer as Meta's EXACT connect webhook and post it in.
app.post('/call/start', async (req, res) => {
  const sdp = req.body?.sdp;
  if (!sdp) return res.status(400).json({ error: 'sdp required' });
  const callId = `wacid.HARNESS-${Date.now()}`;
  calls.set(callId, { sdpAnswer: null, actions: [], startedAt: Date.now(), accepted: false });

  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'HARNESS',
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

  try {
    const r = await fetch(APP_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(`[harness] connect → ${APP_WEBHOOK} (${r.status}) call ${callId}`);
  } catch (e) {
    console.error('[harness] webhook post failed:', e?.message);
    return res.status(502).json({ error: 'app webhook unreachable' });
  }
  res.json({ id: callId });
});

// The browser polls here until the app's pre_accept lands — or until the app
// declines. Reporting `ended` matters: outside working hours the app rejects,
// and a page that only ever waited for an SDP would spin forever with the
// microphone held open.
app.get('/call/answer', (req, res) => {
  const c = calls.get(String(req.query.id || ''));
  if (!c) return res.status(200).json({ ended: 'unknown' });
  if (c.ended && !c.sdpAnswer) return res.status(200).json({ ended: c.ended });
  if (!c.sdpAnswer) return res.sendStatus(204);
  res.json({ sdp: c.sdpAnswer, accepted: c.accepted, ended: c.ended || null });
});

// Hang up: post Meta's terminate webhook with a computed duration.
app.post('/call/stop', async (req, res) => {
  const id = String(req.body?.id || '');
  const c = calls.get(id);
  if (!c) return res.status(404).json({ error: 'unknown call' });
  const duration = Math.max(0, Math.round((Date.now() - c.startedAt) / 1000));
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'HARNESS',
        changes: [
          {
            field: 'calls',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+216 73 000 111', phone_number_id: PNID },
              calls: [
                {
                  id,
                  to: PNID,
                  from: FROM,
                  event: 'terminate',
                  direction: 'USER_INITIATED',
                  status: 'Completed',
                  start_time: String(Math.floor(c.startedAt / 1000)),
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
  try {
    await fetch(APP_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(`[harness] terminate → call ${id} (${duration}s)`);
  } catch (e) {
    console.error('[harness] terminate post failed:', e?.message);
  }
  calls.delete(id);
  res.json({ ok: true });
});

// ── the "Meta Graph" side (what the app's REAL transport talks to) ───────────
// Any version segment is accepted so bumping WHATSAPP_GRAPH_VERSION never
// silently 404s the harness.
app.post('/:version/:pnid/calls', (req, res) => {
  const { call_id: callId, action, session } = req.body || {};
  const c = calls.get(String(callId));
  console.log(`[harness] ← ${action} for ${callId}${session?.sdp ? ' (+sdp)' : ''}`);
  if (c) {
    c.actions.push({ at: Date.now(), action });
    if (session?.sdp && !c.sdpAnswer) c.sdpAnswer = session.sdp;
    if (action === 'accept') c.accepted = true;
    if (action === 'reject' || action === 'terminate') c.ended = action;
  }
  res.json({ success: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, calls: calls.size, appWebhook: APP_WEBHOOK }));

// Loopback ONLY by default: this endpoint accepts unauthenticated call actions
// and forges webhooks at the app — it must not be reachable from the LAN unless
// someone deliberately asks for it (HARNESS_HOST=0.0.0.0 for a phone on Wi-Fi;
// note that getUserMedia needs a secure context, so plain http will only work
// on localhost anyway).
app.listen(PORT, HOST, () => {
  console.log(`call-harness on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (bound to ${HOST})`);
  console.log(`  app webhook : ${APP_WEBHOOK}`);
  console.log(`  tenant pnid : ${PNID}   caller: ${FROM}`);
  console.log('  start the app with: VOICE_CALL_TRANSPORT=real VOICE_CALL_GRAPH_BASE=http://localhost:' + PORT);
});

// ── the page (vanilla JS, no build step) ─────────────────────────────────────
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Omen call harness</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0d0f12;color:#edeef1;padding:2.5rem;line-height:1.6;max-width:44rem;margin:auto}
  h1{color:#c9a86a;font-size:1.4rem}
  button{font:inherit;padding:.7rem 1.4rem;border-radius:.5rem;border:0;cursor:pointer;margin-right:.6rem}
  #call{background:#2f9e63;color:#fff} #hang{background:#b4483c;color:#fff}
  button:disabled{opacity:.4;cursor:not-allowed}
  #status{margin-top:1.4rem;padding:1rem;background:#16191e;border-radius:.5rem;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.85rem}
  .t{font-size:2rem;color:#c9a86a;font-variant-numeric:tabular-nums}
  small{color:#8b929c}
</style></head><body>
<h1>📞 Omen call harness</h1>
<p>Speaks Meta's exact Calling API wire format at the app. V1 echoes your audio back —
<strong>you should hear yourself</strong>. Headphones recommended (feedback).</p>
<p><button id="call">Call the clinic</button><button id="hang" disabled>Hang up</button></p>
<div class="t" id="timer">0:00</div>
<audio id="remote" autoplay></audio>
<div id="status">idle</div>
<p><small>Requires the app running with VOICE_CALL_TRANSPORT=real and
VOICE_CALL_GRAPH_BASE pointed here.</small></p>
<script>
const $ = (id) => document.getElementById(id);
let pc = null, stream = null, callId = null, tick = null, t0 = 0, poll = null;
const log = (m) => { $('status').textContent = m + '\\n' + $('status').textContent.split('\\n').slice(0,12).join('\\n'); };

function stopAll() {
  clearInterval(tick); clearInterval(poll); tick = poll = null;
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('call').disabled = false; $('hang').disabled = true;
}

$('call').onclick = async () => {
  $('call').disabled = true;
  try {
    log('requesting microphone…');
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc = new RTCPeerConnection();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    // werift answers with addTrack() and no MediaStream, so its SDP carries no
    // a=msid — unified-plan browsers then fire ontrack with e.streams === [].
    // Building a stream from the bare track is what actually makes the echo
    // audible; e.streams[0] alone assigns undefined and you hear nothing.
    pc.ontrack = (e) => {
      $('remote').srcObject = e.streams[0] || new MediaStream([e.track]);
      log('remote audio attached (echo)');
    };
    pc.onconnectionstatechange = () => log('pc: ' + pc.connectionState);

    await pc.setLocalDescription(await pc.createOffer({ offerToReceiveAudio: true }));
    // Vanilla ICE: Meta has no trickle channel, so wait for a complete SDP.
    if (pc.iceGatheringState !== 'complete') {
      log('gathering ICE…');
      await new Promise(r => { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 4000); });
    }
    log('posting connect webhook…');
    const started = await (await fetch('/call/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription.sdp })
    })).json();
    if (!started || !started.id) { log('ERROR: the harness could not reach the app webhook'); stopAll(); return; }
    callId = started.id;
    log('ringing — call ' + callId);
    $('hang').disabled = false;

    poll = setInterval(async () => {
      const r = await fetch('/call/answer?id=' + encodeURIComponent(callId));
      if (r.status !== 200) return;
      const body = await r.json();
      // The app declined (closed hours) or hung up: stop polling and RELEASE THE
      // MICROPHONE. Spinning here forever with a hot mic is the worst outcome.
      if (!body.sdp) {
        clearInterval(poll); poll = null;
        log('call ended by the clinic (' + body.ended + ')');
        callId = null; stopAll(); return;
      }
      clearInterval(poll); poll = null;
      await pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
      log('answer applied — connecting media');
      t0 = Date.now();
      tick = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        $('timer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      }, 250);
    }, 500);
  } catch (e) {
    log('ERROR: ' + e.message); stopAll();
  }
};

$('hang').onclick = async () => {
  $('hang').disabled = true;
  if (callId) await fetch('/call/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: callId }) }).catch(()=>{});
  log('hung up'); stopAll();
};
window.addEventListener('beforeunload', () => { if (callId) navigator.sendBeacon('/call/stop', new Blob([JSON.stringify({id:callId})], {type:'application/json'})); });
</script></body></html>`;
