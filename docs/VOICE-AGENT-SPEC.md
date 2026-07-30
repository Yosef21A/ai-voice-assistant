# VOICE-AGENT-SPEC — the assistant answers CALLS (session brain, 2026-07-31)
> Next tier: patients CALL the clinic's WhatsApp (and later a phone number) and the agent picks up, talks in Libyan/Tunisian Arabic or French, books appointments, hands off to humans. Read after CLAUDE.md + docs/HANDOFF-STATE.md. This is an R&D track — phased with HONEST feasibility gates. Update this file at every session end (state, findings, next). Revenue does NOT wait on this: chat agent keeps selling.

## Ground truth (verified 2026-07-31)
- **WhatsApp Business Calling API is real and GA (2025 launch, global 2026):** part of Cloud API; users call the business's WhatsApp number over VoIP; calls can be routed to YOUR WebRTC/SIP stack; **cannot bridge to PSTN**; supports in-call DTMF/IVR keypad on WhatsApp. Our WABA already shows the `calls` webhook field SUBSCRIBED in the console.
- Access caveat: full calling may be gated by number/tier (test numbers may not accept calls). **Gate G0 decides the build path — check before building.**
- PSTN ("normal phone calls") is a SEPARATE rail (Twilio/Vonage + a number). Tunisia local numbers are hard to get on CPaaS; pilot reality: WhatsApp calls ARE how Libyan patients call clinics anyway. PSTN = demo-grade later, not pilot-critical.

## G0 findings (2026-07-31) — GATE DECIDED: Path B (local WebRTC harness first)
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
- **G0 — Feasibility probe (DO FIRST, ~1h):** read Meta Cloud API Calling docs fresh; check calling enablement on our WABA/test number via API + console (calling settings endpoint / phone number settings). Outcome A: calls enabled on test number → build V1 against the real thing. Outcome B: gated to production/BSP tier → build V1 against a LOCAL WebRTC harness (browser mic test page) so 90% of the stack is done before the real number exists. Either way write findings HERE.
- **V1 — Signaling + media skeleton:** `src/voice-call/` — call webhook handling (accept/reject per tenant working hours + voicemail-style message when closed), SDP answer via Graph, RTP/Opus media leg (candidate libs: werift or node-webrtc alternatives; pure-JS preferred per repo rules — document the choice), echo test ("agent" repeats what it hears) end-to-end. Latency measured and logged.
- **V2 — The talking brain:** Gemini Live loop with per-tenant persona + KB grounding + STRICT guardrail preamble; barge-in handling (caller interrupts → stop TTS); slot capture into the existing booking executor with SPOKEN confirmation of date/time before locking ("نأكد: الاثنين العاشرة صباحاً، صحيح؟"); DTMF fallback menu (press 1 booking / 2 human) for noisy lines; hard cap call duration; degrade path: if brain unavailable → polite message + "we'll message you here on WhatsApp" + auto text follow-up (EXISTING chat engine takes over — killer move).
- **V3 — Handoff + ops:** live transfer to staff (call the clinic's human via second WhatsApp call or announce + drop with instant chat handoff), owner notifications (missed call 🔥, voice booking ✅), call recording OFF by default (consent/regulatory caution — Tunisia rules unverified; transcript-only default), stats screen: calls tab.
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
