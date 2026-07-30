# VOICE-AGENT-SPEC — the assistant answers CALLS (session brain, 2026-07-31)
> Next tier: patients CALL the clinic's WhatsApp (and later a phone number) and the agent picks up, talks in Libyan/Tunisian Arabic or French, books appointments, hands off to humans. Read after CLAUDE.md + docs/HANDOFF-STATE.md. This is an R&D track — phased with HONEST feasibility gates. Update this file at every session end (state, findings, next). Revenue does NOT wait on this: chat agent keeps selling.

## Ground truth (verified 2026-07-31)
- **WhatsApp Business Calling API is real and GA (2025 launch, global 2026):** part of Cloud API; users call the business's WhatsApp number over VoIP; calls can be routed to YOUR WebRTC/SIP stack; **cannot bridge to PSTN**; supports in-call DTMF/IVR keypad on WhatsApp. Our WABA already shows the `calls` webhook field SUBSCRIBED in the console.
- Access caveat: full calling may be gated by number/tier (test numbers may not accept calls). **Gate G0 decides the build path — check before building.**
- PSTN ("normal phone calls") is a SEPARATE rail (Twilio/Vonage + a number). Tunisia local numbers are hard to get on CPaaS; pilot reality: WhatsApp calls ARE how Libyan patients call clinics anyway. PSTN = demo-grade later, not pilot-critical.

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
