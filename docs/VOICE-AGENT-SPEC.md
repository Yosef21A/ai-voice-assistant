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

## V5 — HUMAN-VOICE QUALITY LADDER (founder priority 2026-07-31: "must not feel AI")
Ordered execution; T0 is free and ships first; T2 is the demo/pilot voice. TTS is ~70% of the human illusion, turn-taking ~20%, conversation design ~10%.

### T0 — SHIPPED (commit `76c4131`, 2026-07-31): all 7 items. Parallel brain warm-up + per-tenant greeting tape (tenant:lang:codec[:provider:voice]-keyed; tee aborts on ANY caller speech — review CRITICAL: a caller-influenced tape carried patient PII across callers), turn discipline + one nudge, derja backchannels/fillers, VAD endpointing config (first live call validates field names — LIVE SETUP REJECTED log exists for it), barge-in metering incl. the tape, returning-patient personalization (whitelist name sanitizer), per-turn latency in call.ended.
### T1 — SHIPPED (commit `dd2b5ae`, 2026-07-31): src/voice-call/brain/tts/ chain — gemini (native, default) / azure (ar-TN-Reem default, raw 24k PCM) / elevenlabs (eleven_flash_v2_5, pcm_24000). TEXT-modality loop w/ decimal-safe sentence splitter, ordered speak queue, barge-in aborts HTTP, deterministic emergency via our mouth, cross-call per-provider breaker (exclusive half-open). Mid-call TTS failure = graceful tts_lost end + WhatsApp follow-up (Live modality is immutable per-session). Settings PUT validates clinic.voice. AZURE_SPEECH_KEY/REGION + ELEVENLABS_API_KEY env; hermeticity-pinned in tests.
### T2 — NEXT: needs from the founder: ELEVENLABS_API_KEY in .env + a consented 2-min clean voice sample (clone in the ElevenLabs console, put the voice id in clinic.voice.elevenVoiceId via PUT /api/tenant). Everything else is wired. Dashboard Settings UI for the voice block = small follow-up slice.

### T0 — original plan (reference)
1. **Zero-dead-air pickup:** pre-render/cache the per-tenant greeting audio; play it the instant the call connects (<300ms) while Gemini Live warms. Dead air at pickup is the #1 AI tell.
2. **Turn discipline:** hard cap 1–2 short sentences per turn in the prompt + post-filter; one question max per turn (mirrors chat humanize law).
3. **Dialect micro-behaviors in prompt:** backchannels ("أيوا", "تمام", "باهي"), thinking fillers spoken while tools run ("ثانية برك نشوفلك الموعد…") — never silence during executor work; natural sign-offs.
4. **Endpointing/VAD tuning:** callers pause mid-sentence — raise end-of-speech patience (~800–1200ms), never clip; measure and log false-cut rate.
5. **Barge-in polish:** on caller interrupt, stop TTS within ~150ms, drop the rest of the sentence, respond to the interruption (werift RTP: flush playout buffer).
6. **Personalization:** returning patient → greet by name once; reference prior booking when relevant (store lookup already exists).
7. **Latency budget instrumentation:** log per-turn ms (caller-stop → agent-first-audio); target median <1.2s with filler coverage beyond 800ms.

#### T0 — SHIPPED (all 7 items). Where each one lives:
| # | Where | Notes |
|---|---|---|
| 1 | `src/voice-call/index.js` `warmBrain()` + `loop.warmUp()`/`start()`; `src/voice-call/brain/greetingCache.js` | The Live handshake now overlaps pre_accept/accept instead of starting after media connects. First call per tenant/lang/**codec** tees its greeting frames; later calls replay them into the paced queue before `start()` returns and the model is told, as CONTEXT (`turnComplete:false`), that it already greeted. Barged-in, tool-calling and PERSONALIZED greetings are never taped. `VOICE_GREETING_CACHE=off`. |
| 2 | `brain/prompts.js` `voiceStyleBlock` + `brain/loop.js` `noteAgentSpeech()` | Prompt: max 2 short sentences, exactly one question, never a list, never re-explain. Code: 2 turns over 220 chars ⇒ ONE corrective, sent as context, never during an emergency. |
| 3 | `brain/prompts.js` `HUMAN_TOUCHES` (ar/fr/en) | Backchannels, a MANDATORY thinking filler before every tool call, natural sign-offs. `loop.js` logs any executor call over 600 ms — that log is where "the filler did not cover it" shows up. |
| 4 | `brain/liveClient.js` `buildActivityDetection()` | `realtimeInputConfig.automaticActivityDetection` = `{ endOfSpeechSensitivity, silenceDurationMs, prefixPaddingMs }`. Unknown enum values are DROPPED rather than sent (a rejected setup closes the socket and degrades the call). `VOICE_VAD_SILENCE_MS=1000`, `VOICE_VAD_END_SENSITIVITY=END_SENSITIVITY_LOW` (`off` ⇒ server defaults), `VOICE_VAD_PREFIX_PADDING_MS=60`. A pre-`setupComplete` close now logs the code, the reason and the redacted setup. |
| 5 | `brain/loop.js` `flushOutbound('barge_in')` | Frames dropped + flush ms logged per barge-in; count on `stats()` and on `outcome().bargeIns`. |
| 6 | `brain/loop.js` `loadCallerContext()` | `store.appointments.list(tenantId, { patientWaId })` — tenant-scoped on purpose. Name (sanitized, ≤60 chars, brackets/control chars stripped) + the next pending/confirmed appointment. Nothing else about a patient enters a spoken prompt. |
| 7 | `brain/loop.js` pacer hook + `latencySummary()` | caller-stop → the first frame actually handed to `media.sendRtp`. `outcome().latency = { turns, medianMs, p95Ms, worstMs, greetingMs, greetingSource }`, rides on `call.ended` and the transcript row; one summary line per call at stop(). |

Live numbers to watch on the next real call: `greeting=<ms> (cache|live)` should be <300 ms on the second call of a tenant, and `median` should sit under 1.2 s.

### T1 — Cheap human mouth (~$0.01–0.02/min): Azure Neural TTS
Keep Gemini ears+brain; stream sentence-level TTS via Azure `ar-TN`/`ar-LY` neural voices (verify current voice list + pricing at build). Provider interface: `src/voice-call/brain/tts/` with `geminiNative` (default, free) + `azure` + `elevenlabs` implementations, per-tenant `voice` config. Fallback chain: chosen provider error → geminiNative → degrade path.

#### T1 — SHIPPED (2026-07-31). Where it lives, and the one design correction:
| Piece | Where |
|---|---|
| The chain | `brain/tts/index.js` — `createTtsChain({config, clinic, logger, fetchImpl})` → `{mode:'native'\|'tts', provider, voice, synthesize, normalizeSpoken, cacheKey, describe}`. Selection: `clinic.voice.provider` → `VOICE_TTS_PROVIDER` → `gemini`. A provider named without its credential (or with a bad region / missing `elevenVoiceId`) logs **one** warning and keeps the native voice — selling a voice upgrade can never take a phone line down. |
| Azure | `brain/tts/azure.js` — POST `https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`, `X-Microsoft-OutputFormat: raw-24khz-16bit-mono-pcm`, SSML with `xml:lang` DERIVED from the voice name. Defaults ar→`ar-TN-ReemNeural`, fr→`fr-FR-DeniseNeural`, en→`en-US-JennyNeural`; ar-LY voices in the table. Model text is XML-escaped; the voice name and region are whitelist-validated (SSML injection / SSRF). |
| ElevenLabs | `brain/tts/elevenlabs.js` — POST `/v1/text-to-speech/<voiceId>/stream?output_format=pcm_24000&optimize_streaming_latency=3`, `eleven_flash_v2_5`. No default voice id, ever: a clone belongs to a consenting person. 429 → typed quota error. |
| Shared wire | `brain/tts/wire.js` — one fetch, an 8 s **stall** budget re-armed per chunk (not a one-shot deadline), the odd-byte carry across chunk boundaries, and the rule that a CALLER abort is re-thrown untouched so a barge-in never looks like an outage. |
| Loop | `brain/loop.js` — TTS mode opens Live with `responseModalities:['TEXT']`, buffers the `text` stream into sentences (≥12 chars, forced at 240), synthesizes in order through the SAME `codec.encodeOut → outQueue → pacer` path. Barge-in aborts the in-flight HTTP request AND invalidates the generation. The greeting tape works unchanged but its commit is queued BEHIND the speech, and the cache key gains the provider+voice. The emergency script is spoken by OUR mouth (the model is only told to stay quiet). |
| Cross-call breaker | `brain/tts/breaker.js` — process-global, per provider, same shape as `createBrainBreaker`. Two calls lost to a vendor (`tts_lost`) and the next call composes the NATIVE voice instead of opening a doomed TEXT session; ONE exclusive probe after the cooldown re-opens on failure and closes on a call that actually spoke. `VOICE_TTS_BREAKER_THRESHOLD=2`, `VOICE_TTS_BREAKER_COOLDOWN_MS=300000`. Transitions owned by `voice-call/index.js` (failure in `onBrainEnd`, success in `finish()`); alert kind `voice_tts_breaker_open`. |
| Settings / config | `api/tenant.js` accepts a closed `voice` block (`provider`, `voiceId`, `azureVoice`, `elevenVoiceId`, ≤80 chars) and validates the SHAPE with the providers' own exported regexes, so a malformed voice name is a 400 at save time rather than a silent downgrade found on a live call. `config.js`: `VOICE_TTS_PROVIDER`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `ELEVENLABS_API_KEY`, `VOICE_TTS_BREAKER_*` — TTS keys all pinned empty in `test-helpers/client.js`. |

**Sentence splitting is a medical-safety surface, not a formatting detail.** A naive split on `.` turned "الفحص يبدا من 1.500 دينار للكشف." into two utterances — the caller heard a WRONG PRICE from a clinic. The splitter therefore requires whitespace after a terminator, treats a terminator at the end of the buffer as undecidable (it waits for the next fragment or the end-of-turn flush), never cuts a `.` between two digits, never cuts after an initial or a known abbreviation (`Dr.`, `a.m.`, `د.`), treats a run like `...` as ONE terminator, and never turns a letterless fragment into a synthesis request.

**Design correction vs the original plan.** "chosen provider error → geminiNative" is NOT implementable mid-call: `responseModalities` lives in the Live `setup` frame, which is sent once and is immutable, so a TEXT session can never produce audio. A provider that dies mid-call therefore degrades exactly like a dead brain — outcome reason `tts_lost`, the call is terminated and the existing `callBrainLost` WhatsApp follow-up hands the patient to the chat engine. Falling back to the native voice would require tearing down and rebuilding the Live session mid-conversation (losing dialogue state, several seconds of silence): a real future option, deliberately not half-built here. The provider fallback that DOES exist is at call setup, where it costs nothing.

### T2 — The illusion (~$0.05–0.15/min): ElevenLabs cloned dialect voice
- Instant-clone a CONSENTED native Tunisian speaker (founder or friend; 2-min clean sample; written consent stored). One male + one female voice per dialect eventually; per-tenant selection in wizard/settings.
- ElevenLabs Flash/Turbo multilingual, streamed; keep sentences short (clones amplify long-sentence drift).
- COGS note: meter minutes per tenant (stats already track call duration) — voice minutes are a real cost; Concierge tier absorbs them, pass-through clause pattern already exists in contracts.
- Env: ELEVENLABS_API_KEY (never commit); quota/429 → fallback chain.
### T3 — S2S premium (OpenAI Realtime-class): PARKED — best turn-taking, weakest guardrail control, weak dialect AR, highest cost. Revisit only if a client demands English/French-first voice.

### Acceptance for "human" (test with real Tunisian/Libyan listeners)
Blind test: 5 native listeners hear a 60s booking call; ≥3/5 unsure or wrong about "human or AI" = pass at T2. Also: zero dead-air >1.2s uncovered by filler; zero mid-word caller clips in a 10-call sample; booking correctness unchanged (executor law).

## V6 — LIVE-CALL FIELD FIXES (founder test verdict 2026-08-01: "slow, unnatural, fails in noise" — this is the active work order, before/alongside V5 tiers)
Founder called the live agent. Verdict: (a) response latency "takes years", (b) doesn't feel natural, (c) breaks with room noise / multiple speakers. Requirements: sub-1.2s felt latency, graceful noise behavior, single-caller focus like a human receptionist.

### V6.1 — LATENCY FORENSICS FIRST (measure before touching anything)
Instrument every hop with timestamps logged per turn: caller-speech-end (VAD) → endpoint decision → Live API audio-in flush → first model token/audio-out → TTS/RTP first packet → caller hears. Produce a waterfall for 10 real turns. THEN fix the biggest bars, expected culprits in order:
1. **Endpointing too patient/too chunky** — if we wait for long silence before flushing, we add 800ms+ before the brain even starts. Stream audio continuously to Gemini Live (it does its own VAD) instead of buffering utterances, if not already; tune end-of-speech to ~600–800ms with barge-in as the safety valve.
2. **No streamed playback** — ensure model audio streams to RTP as it generates (chunked), never waiting for full response.
3. **Greeting + fillers** (V5-T0): cached instant greeting; spoken micro-filler when a tool/executor call will exceed ~700ms ("ثانية برك…"). Perceived latency is the metric — a filled 1.5s feels instant, a silent 900ms feels broken.
4. **Prompt weight** — trim the system prompt/KB context for voice (top-k only); long contexts add first-token latency on free-tier Live.
5. **Free-tier reality check:** log Gemini Live's own turn latency in isolation. If the model floor itself is >1.5s on free tier, escalate recommendation to founder: paid Live tier or T1/T2 pipeline (Azure/ElevenLabs streaming TTS keeps mouth fast even when brain is slow, because fillers + first-sentence streaming mask it).

### V6.2 — NOISE & MULTI-SPEAKER BEHAVIOR (act human, not perfect)
A human receptionist doesn't transcribe a crowd — she focuses the caller and asks again when unsure. Encode exactly that:
1. **Noise suppression pre-brain:** RNNoise (WASM build, zero native deps) on inbound PCM before the Live API; measure CPU cost; feature-flag it.
2. **Prompt-level focus policy:** "Multiple voices/background speech: address ONLY the primary caller (loudest/most consistent voice, the one conversing with you). NEVER answer background conversations. If overlap makes the request unclear, say so warmly and ask the caller to repeat — in their dialect ('سامحني، فما حس برشة — تنجم تعاود آخر حاجة؟')."
3. **Confidence gates on slots:** in noisy turns, the existing confirm-before-lock gate becomes MANDATORY for every slot (name/date/phone spelled back digit-by-digit).
4. **Two-strike noise rule:** twice unclear in a row → offer choices: continue on chat ("نبعثلك رسالة هنا ونكملو كتابة؟" — the killer degrade path already built), DTMF menu, or human callback + owner alert.
5. **Golden noise tests:** feed pre-mixed noisy fixtures (voice+café noise, two speakers) through the fake-provider harness asserting: no slot locked without confirmation, two-strike triggers, no background-speech answers.

### Acceptance (founder re-test)
Median felt latency <1.2s across 10 turns (waterfall attached to spec); a call from a noisy room completes a booking with correct spelled-back details OR gracefully lands on chat; founder says "it feels like a person answered."

## V7 — PIPELINE REBUILD: the fast cascade (supersedes incremental V6 tuning as the primary path; V6.2 noise rules still apply)
**Verdict (war-room research, sourced, 2026-08-01):** Gemini Live measured 2.98s TTFT by Coval — slowest of its class; no tuning beats a slow brain. Pro agents (Vapi p50 <500ms, Retell ~600ms) run an overlapped cascade. Verified numbers support **0.8–1.3s voice-to-voice for Arabic (tuned floor ~700ms)**. Cost ~$0.03–0.06/min (TTS-dominated; Azure fallback cuts to ~$0.015). Gemini Live stays as `VOICE_BRAIN=live` legacy mode + final fallback.

### Verified provider picks (research report 2026-07-31; re-verify pricing at build)
| Layer | PRIMARY | Why | FALLBACK |
|---|---|---|---|
| STT | **Deepgram Nova-3 `ar-TN`** WSS streaming | Only explicit Tunisian code; sub-300ms; $200 credit (~690h); $0.0048/min | **Speechmatics** (Maghrebi named incl. Tunisian, AR↔EN code-switch, 50h/mo free); no ar-LY exists anywhere → generic `ar` for Libyan callers |
| EOT/VAD | External VAD tuned 250–400ms (biggest latency line item per Vapi/Pipecat data) | Deepgram Flux has no Arabic | — |
| LLM | **Gemini Flash-Lite TEXT, thinking DISABLED**, streaming | Only family with published Tunisian-derja competence (TounsiBench); thinking-on = ~6s TTFT trap | Cerebras (1M tok/day free) / Groq free — test but unbenchmarked on derja |
| TTS | **ElevenLabs Flash v2.5 WS stream-input** (~75ms TTFB; key owned) | Fastest; incremental text input; clone Tunisian voice for dialect (no Maghrebi stock voice) | **Azure Neural `ar-TN` Hedi/Reem + `ar-LY` Omar** — only real Tunisian/Libyan voices, 500k chars/mo FREE, 3× cheaper |

### Architecture (src/voice-call/brain-cascade/ — new module beside brain/, flag VOICE_BRAIN=cascade|live)
```
RTP in → VAD/EOT (250–400ms, barge-in aware)
      → Deepgram WSS (interim + final transcripts)
      → SPECULATIVE START: LLM begins on stable interims; discard+restart if final differs materially
      → Gemini Flash-Lite text stream (voice-turn prompt: 1–2 short sentences, dialect, persona, KB top-k;
        SAME tools/executor/guardrails as brain/ — emergency detector still runs BEFORE, deterministic law unchanged)
      → sentence/clause chunker → ElevenLabs Flash WS (incremental) → PCM→G.711/Opus → RTP out
      → BARGE-IN: caller speech during playback → kill TTS stream + flush RTP buffer <150ms, keep LLM context
      → filler audio if LLM TTFT >700ms (cached per-tenant clips)
```
Per-turn waterfall logged (vad_ms, stt_final_ms, llm_ttft_ms, tts_ttfb_ms, first_audio_ms) → stats + spec.

### Phases
- **P0 — Spikes + bake-off (no integration):** tiny probes per provider through the existing harness with REAL mic audio (Tunisian phrases): measure each layer 10×, write the table INTO this spec. Needs founder keys: Deepgram signup ($200 credit), optional Cerebras/Groq, optional Azure. ElevenLabs exists.
- **P1 — Orchestrator core:** brain-cascade module per architecture; unit tests with fake providers (speculative restart, chunker, barge-in kill-chain, filler trigger); guardrail regressions.
- **P2 — Integration + A/B:** wire behind VOICE_BRAIN flag; fallback chains (STT: deepgram→speechmatics→degrade-to-chat · LLM: flashlite→cerebras→live · TTS: elevenlabs→azure→live); 10-call A/B cascade vs live with waterfalls; suite green; commit per phase.
- **P3 — Founder re-test:** acceptance = median felt ≤1.2s, p95 ≤2.0s, correct booking with spell-back, V6.2 noise behavior intact, "feels like a person answered."
