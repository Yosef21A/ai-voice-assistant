# VOICE-AGENT-SPEC — the assistant answers CALLS (session brain, 2026-07-31)
> Next tier: patients CALL the clinic's WhatsApp (and later a phone number) and the agent picks up, talks in Libyan/Tunisian Arabic or French, books appointments, hands off to humans. Read after CLAUDE.md + docs/HANDOFF-STATE.md. This is an R&D track — phased with HONEST feasibility gates. Update this file at every session end (state, findings, next). Revenue does NOT wait on this: chat agent keeps selling.

## Ground truth (verified 2026-07-31)
- **WhatsApp Business Calling API is real and GA (2025 launch, global 2026):** part of Cloud API; users call the business's WhatsApp number over VoIP; calls can be routed to YOUR WebRTC/SIP stack; **cannot bridge to PSTN**; supports in-call DTMF/IVR keypad on WhatsApp. Our WABA already shows the `calls` webhook field SUBSCRIBED in the console.
- Access caveat: full calling may be gated by number/tier (test numbers may not accept calls). **Gate G0 decides the build path — check before building.**
- PSTN ("normal phone calls") is a SEPARATE rail (Twilio/Vonage + a number). Tunisia local numbers are hard to get on CPaaS; pilot reality: WhatsApp calls ARE how Libyan patients call clinics anyway. PSTN = demo-grade later, not pilot-critical.

## G0 UPDATE (2026-07-31 ~03:00, fresh token) — **GATE FLIPPED TO PATH A: REAL CALLS**
`node scripts/probe-calling.js --enable` against our test number `1153135121224452`:
settings showed `calling.status: NOT_SET` → the enable POST returned `{"success":true}` → settings now read
`"calling": {"status": "ENABLED", "call_icon_visibility": "NOT_SET", "callback_permission_status": "NOT_SET"}`.
The 2k-recipient tier gate did NOT apply to user-initiated calling on the test number. Everything below
(V1 signaling, V2 brain, V3 ops) was built against the exact live contract via the Path-B harness, so
Path A needs zero code changes: webhook re-pointed at the live tunnel + server restarted = the agent
answers real WhatsApp calls. `subscribed_apps` re-confirmed the same night ({"success":true} re-POST).

## G0 findings (2026-07-31) — original gate decision: Path B (local WebRTC harness first)
Probed fresh Meta docs + third-party integrations (webrtc.ventures walkthrough, pipecat, 360dialog, arslan1317/whatsapp-calling reference impl). The API probe against OUR number is blocked today — token expired (OAuthException 190 confirmed 2026-07-31); `scripts/probe-calling.js` is ready to run the moment a fresh token lands in `.env` (add `--enable` to attempt enablement).

**Signaling contract (Graph API, verified):**
- Webhook field `calls` (already SUBSCRIBED on our app). `connect` event:
  `{ "calls": [{ "id": "wacid.…", "from": "<user>", "to": "<biz>", "event": "connect", "direction": "USER_INITIATED", "timestamp": "…", "session": { "sdp_type": "offer", "sdp": "<RFC 8866 SDP>" } }] }`
- `terminate` event: `{ id, event: "terminate", status: "Completed"|"Failed", start_time, end_time, duration }` — sent whichever side hangs up.
- Business answers via `POST /<PHONE_NUMBER_ID>/calls` with `{ messaging_product: "whatsapp", call_id, action, session? }`:
  `pre_accept` (send SDP answer early → WebRTC handshake happens pre-accept, audio flows instantly, no clipping) → `accept` (same SDP answer, + optional `biz_opaque_callback_data`) — also `reject` and `terminate` (no session). All return `{ success: true }`.
- **Window: ~30–60s** from connect webhook to accept, else caller sees "Not Answered" + terminate webhook.
- DTMF: only 8000 clock rate telephone-event in Meta's SDP. Messages can flow on the same conversation DURING a call (degrade path is real).

**Media contract:** WebRTC — ICE + DTLS-SRTP. Codecs: Opus, + PCMA/PCMU (G.711) since Mar 2026. SDES-SRTP (skips ICE/STUN/DTLS entirely) exists but ONLY on the SIP signaling path, not Graph. 1,000 concurrent calls/WABA cap.

**Enablement (the gate):** `POST /<PHONE_NUMBER_ID>/settings` body `{"calling":{"status":"ENABLED"}}`. Calling is **disabled by default on test numbers**; production enablement requires the number's messaging tier ≥ 2,000 unique recipients/day (ours is a 5-recipient test number). Sandbox accounts waive the tier requirement but are **Tech Partners only** (that's our Phase-3 track anyway). Expectation: our test number will refuse enablement → **Outcome B**.

**Decision:** Build V1 against a **local harness speaking the EXACT Graph contract** — a harness endpoint that POSTs a synthetic `calls` connect webhook (real SDP offer from a local WebRTC peer) and a mock Graph `/calls` endpoint that accepts pre_accept/accept and completes the handshake. The voice-call stack (signaling state machine, SDP answer, RTP loop, brain) is then 100% real; flipping to real WhatsApp calls = pointing the webhook at Meta + the sender at graph.facebook.com. Re-run the probe when the token returns; if enablement unexpectedly succeeds → live call test immediately.

**Media lib decision:** `werift` 0.24.2 — pure-TypeScript WebRTC for Node (ICE/DTLS/SRTP/RTP, zero native deps; repo rule: boring, portable). Opus decode/encode NOT needed for V1 echo (loop RTP payloads); V2 uses `opusscript` (WASM) or G.711 (PCMA/PCMU, trivial codec — now supported by Meta) for the PCM bridge to the realtime brain. `wrtc`/node-webrtc rejected: native binaries, unmaintained, Windows-hostile.

## Architecture (one brain, new mouth)
```
WhatsApp call → Meta calls webhook (offer/SDP or call event)
             → src/voice-call/ signaling: accept via Graph API, establish WebRTC/SIP leg
             → media loop: caller audio (Opus/RTP) ⇄ REALTIME BRAIN
             → REALTIME BRAIN options (pick at V1 after latency test):
               A. Gemini Live API (native speech-in/speech-out streaming, same key family) — cheapest, fastest to build
               B. Pipeline: chunked STT (Gemini) → humanize engine (EXISTING) → TTS (Gemini TTS preview / other) — more control, higher latency
             → EXISTING deterministic layer stays the law: executor validates any booking action;
               emergency keywords → spoken emergency message + instant human transfer + owner alert
             → transcript logged to the SAME conversation thread in the inbox (call = conversation entries)
```
Principles: the voice layer is a TRANSPORT (like webhook/simulate) — engine + guardrails unchanged. Every call produces: transcript in inbox, outcome (booked/lead/handoff/missed), owner notification, stats entries (calls answered, after-hours calls, bookings-by-voice).

## Phases & gates
- **G0 — Feasibility probe — DONE (2026-07-31).** Path B decided: local WebRTC harness first (see G0 findings above).
- **V1 — Signaling + media skeleton — DONE (commit `60eecbc`).** `src/voice-call/` call webhook handling (accept/reject per tenant working hours + voicemail-style message when closed), SDP answer via Graph, werift RTP media leg, V1 echo path end-to-end, audit trail (`call.started`/`call.missed`/`call.ended` bus events + `store.events.append` rows), adversarially hardened against mid-flight races (terminate-during-accept, terminate-during-makeMedia, tenant-scoped terminate, redelivery dedupe).
- **V2 — The talking brain — DONE (commit `b854dac`).** `src/voice-call/brain/` — Gemini Live loop with per-tenant persona + KB grounding + the SAME guardrail/emergency detector as chat; deterministic two-phase booking gate with spoken confirmation before locking; consecutive-failure breaker on the Live endpoint; degrade path (brain lost → polite spoken line + hang up + WhatsApp follow-up, existing chat engine picks the patient up). Bookings ride `appointment.created` with `channel:'call'`; the terminal event's `call.brain` carries `{booked, handoff, emergency}`.
- **V3 — Handoff + ops — DONE (this slice).** Live transfer SHIPPED AS announce + drop with instant chat handoff (V2's `request_handoff` — the caller is told a human will follow up in writing, the bot steps back on the same thread); TRUE second-call transfer (dialing staff on a second WhatsApp call) is gated on business-initiated calling permissions, capped at 1/day in production — revisit once the production number is live. Recording stays OFF by design, transcript-only — deliberately NO config key for it, so there is nothing to accidentally flip on. Shipped: owner WhatsApp alert on `call.missed` (📵, reason-aware, respects quiet hours/per-recipient toggle, never doubles up with an emergency alert since a held call publishes `call.ended` not `call.missed`); a 📞 marker line on the booking alert when `appointment.channel === 'call'`; a `calls` block in `computeAnalytics`/`computeDigestStats` (total/answered/missed/avgDurationSec/voiceBookings) shared by `/api/stats` and the WhatsApp digests (one `📞 N calls — …` digest line, only when `calls.total > 0`); `GET /api/calls` (tenant-scoped, terminal call rows only); a dashboard **Calls** tab (stat tiles + live list, links each row into the Inbox thread) for every tenant type including facilitators; the Inbox system-bubble rendering fix for `body.by === 'system'` call-summary rows.
- **V4 — PSTN (later, demo-grade):** Twilio trial number + Media Streams → same brain. Honest note: not Tunisia-local; for pilots the WhatsApp-call channel is the product. Revisit local PSTN via Tunisian SIP trunk provider when a paying client demands landline coverage.
- **Testing:** unit-test signaling state machine + guardrail paths with mocked media; latency budget test (<1.5s median turn); golden voice-flow scripts via injected fake STT/TTS so CI never needs audio; live test = Youssef calls the number.

## Session rules
Same as always: plan first, complete files, suite green (356/2 baseline), simulate offline-green, commit per slice, never weaken medical guardrails, never commit .env, live sanity after each slice, update THIS file + HANDOFF-STATE delta at session end. Token ritual + tunnel ritual apply (calls webhooks arrive over the same tunnel).

## Kickoff prompt (paste into Claude Code in the repo)
```
Read CLAUDE.md, docs/HANDOFF-STATE.md (do the start-up ritual), then
docs/VOICE-AGENT-SPEC.md fully. Execute it: G0 feasibility probe FIRST — read
the current Meta Calling API docs, probe our WABA/test number's calling
enablement, write findings into the spec, and tell me which build path (real
calls vs local WebRTC harness) applies. Then V1 → V2 → V3 in order: plan each,
implement complete files with tests, suite green, commit per slice. The
existing engine/executor/guardrails are law — voice is a transport. I'll do
live call tests when you say ready. Update the spec at session end.
```
