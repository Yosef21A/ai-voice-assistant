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

### V7 AMENDMENT (2026-08-01) — Fish Audio + reply-quality upgrades
**TTS bake-off update:** add **Fish Audio S2.1 Pro** as CO-PRIMARY candidate — its API is currently FREE (unlimited fair-use, per Fish's June-2026 announcement; verify at signup), Arabic supported (generic, not Maghrebi — dialect comes from cloning: 15s sample suffices), low-latency streaming API, paid $15/1M UTF-8 bytes (~11× cheaper than ElevenLabs). CAVEATS: measure real TTFB in P0 (no verified number); free tier is non-commercial — pilots need Plus ($5.50/mo promo) or API billing; clone the SAME consented Tunisian sample on Fish AND ElevenLabs and let the founder's ear pick. P0 TTS table now: Fish S2.1 Pro (free) · ElevenLabs Flash (key owned) · Azure ar-TN/ar-LY (real dialect voices, 500k chars/mo free). Env: FISH_API_KEY optional, provider interface already planned.
**Reply-quality upgrades (the brain side — Gemini text is NOT the enemy; Live S2S was):**
1. **Paid Gemini key** (founder task, ~$/month single digits at test volume): kills the free-tier quota exhaustion that silently degrades the bot to classic (a major source of perceived "bad replies") + lifts rate limits. Surface which brain answered in the waterfall log (cascade|live|classic) so quality complaints are attributable.
2. **Derja few-shot pack:** build `src/voice-call/brain-cascade/fewshots.js` — 10–15 exemplar exchanges in Tunisian + Libyan register (mine real transcripts from data/runtime + the golden tests; separate register per tenant dialect config), injected into the voice-turn prompt. This is the highest-leverage naturalness fix.
3. **P0 LLM A/B:** Flash vs Flash-Lite (thinking OFF both) vs Groq/Cerebras oss — score on latency AND a 10-question derja quality sheet the founder grades once. Nothing unbenchmarked on derja ships as primary.

### P1 STATUS — SHIPPED (2026-08-01): the cascade orchestrator, adversarially hardened
`src/voice-call/brain-cascade/`: STT chain (deepgram ar-TN → speechmatics [two-step JWT mint — the API key never rides a URL] → liveEars [free, today] → degrade), free LLM failover chain (flash-lite thinkingLevel:'minimal' → 3-flash-preview → cerebras → groq → classic) with per-provider breakers, provider rotation on 429/quota/empty-stream — NEVER silent degradation, waterfall names the answering provider every turn. Fish s2.1-pro-free TTS in the shared chain (explicit/default native is TERMINAL on the incumbent; the cascade opts in via requireMouth; per-provider voice ids never cross vendors; EL monthly soft-cap). Speculative start with drift re-checks on EVERY final (incl. after promotion), one speculation per utterance, filler only after end-of-turn, barge-in kill-chain, localized DTMF phrases per tenant type, sticky-classic-per-call with forced-classic (zero-network) last link + full event parity (owner alerts/leads/SSE preserved). Metering (sttMs/llmTokens/ttsChars) per call. Review round: 8 confirmed + 9 overflow majors + 7 minors fixed, 0 refuted (incl. a critical: the TTS walk would have flipped the LIVE incumbent to Fish un-gated). Suite: 680 tests / 678 pass / 0 fail / 2 PG-skips. NOT yet wired: nothing reads VOICE_BRAIN until P2.

### P2 STATUS — SHIPPED (2026-08-01): the cascade is wired, flagged, labelled and A/B-able
`VOICE_BRAIN` is finally read by something. `src/voice-call/index.js` now picks the loop factory per call and
everything downstream is unchanged, because the two brains are contract-identical
(`warmUp/start/onRtp/stop/settled/transcript/outcome/stats`).

**Selection rules (`resolveVoiceBrainMode({config, clinic})`, exported + unit-tested).** Precedence
`clinic.voiceBrain` → `config.voiceBrain` (`VOICE_BRAIN`) → `'live'`. **Only the exact literals `'live'` /
`'cascade'` count at every rung** — no trimming, no case folding, byte for byte the rule `voiceCallMode ===
'brain'` uses: `'CASCADE'`, `'Cascade'` and `'cascade '` all mean live, because every way of being wrong about
this flag must land on the brain that already answers phones. An unrecognized TENANT value is junk, not a
choice, so it falls through to the global flag rather than pinning the tenant. The tenant override is validated
in `src/api/tenant.js` exactly like `clinic.voice` (closed set, `''` clears it) and re-validated at call time,
because a hand-edited `clinics.json` never passes through the API.

**Composition-level fallback (loud, once per call, never dead air).** The cascade has no native voice and no
native ears: composing it without either produces a call that connects, greets nobody and degrades. So
`cascade` additionally requires **a mouth** — a Fish or ElevenLabs credential (the doctrine fallback order), OR
a provider named explicitly by the tenant/`VOICE_TTS_PROVIDER` whose own credential is present (this is the
clause that lets an Azure tenant run the cascade even though Azure is parked out of the automatic order) — AND
**ears**: any of `DEEPGRAM_API_KEY` / `SPEECHMATICS_API_KEY` / `GEMINI_API_KEY` (the last one because liveEars
is the free STT leg). Missing either ⇒ the call is composed as **LIVE** with one warning naming exactly what is
missing: `[voice-call] cascade unavailable (<reason>) — live mode for this call`. Resolved **once per call** and
cached on the entry, so the parallel warm-up and `startBrain()` cannot each warn about one decision.
`opts.brainFactory` injection still wins over the factory choice, and the resolved mode is still reported —
"which brain did this call think it was" must not become unanswerable because a test swapped the loop.

**Attribution.** The cascade's `ttsChain` is built by the service with `requireMouth: true` (the only caller
allowed to walk the doctrine fallback order), and both loops now log through the service's logger, so the
per-turn `[voice-cascade] waterfall vad=… stt=… llm_ttft=… tts_ttfb=… first_audio=… · deepgram → flash-lite →
fish` line is wired end to end. `finish()` folds **`brain.mode` (`'cascade'|'live'`)**, the **waterfall tail**
(last 30 turns — the loop keeps 120, but this payload fans out to every open SSE stream) and the **usage meter**
into the call record and the `call.ended` event. `svc.active()` exposes the live mode too. The founder's
"it sounded slow on Tuesday" is now attributable to a pipeline instead of to the product.

**A/B harness — `scripts/cascade-ab.js` (a founder tool, NOT a test; `npm test` never imports it).**
`VOICE_BRAIN` is read once at boot, so one server process has one brain and a per-call flip is impossible.
The A/B is therefore **two runs, compared from the rows the script appends to `docs/V7-AB-RESULTS.md`**:

```
# terminal 1 — the cascade side:
VOICE_BRAIN=cascade VOICE_CALL_MODE=brain WHATSAPP_TRANSPORT=mock \
  VOICE_CALL_TRANSPORT=real VOICE_CALL_GRAPH_BASE=http://localhost:3902 npm start
# terminal 2:
node scripts/cascade-ab.js --mode cascade --calls 10
# then restart the app with VOICE_BRAIN=live and run --mode live
```

The caller is an **in-process werift peer** (no browser): it plays Meta's exact connect/terminate webhooks at
the app while serving the Graph side itself on `:3902`, offers Opus **sendrecv**, and streams a 440 Hz tone
encoded through the real `brain/codec.js` bridge. Measured per call: `connect_ms` (→ pre_accept), `accept_ms`,
`greeting_ms` (accept → first audio the caller hears) and `turn_ms` (last uplink frame → next agent audio) —
i.e. **PLUMBING latency, and it says so**. The model-side numbers are never invented: `vad/stt_final/llm_ttft/
tts_ttfb/first_audio`, the chain, the turn latencies and the usage meter are read back off the call records the
server wrote. A tone is not speech, so a run may legitimately record zero turns; that prints `n/a` rather than a
fabricated number, and real Derja turns stay the founder's own live calls (P3). `--mode` is a label **and** a
safety check: the script shouts if the records say a different `brain.mode` than the row claims, because a
mislabelled A/B is worse than no A/B. A declined call (outside working hours) aborts the run immediately with
that diagnosis instead of grinding through nine more. Verified against a throwaway isolated app: 2/2 calls, full
signaling + DTLS + a 40-frame RTP round trip, records read back.

**Suite: 697 tests / 695 pass / 0 fail / 2 PG-skips** (was 680/678 — +17, all in
`test/voicecall.p2.integration.test.js`: the precedence + fallback matrix, one-warn-per-call, injection-still-
wins, a REAL cascade orchestrator driven through the REAL service end to end with only the three vendor legs
faked, the run-time no-mouth degrade, and the waterfall cap keeping the TAIL). `makeTestApp` stays pinned to
`voiceBrain: 'live'` with every cascade key blanked. `npm run simulate` exit 0.

**Left for P3:** the founder's own re-test on real Derja (median felt ≤1.2 s, p95 ≤2.0 s, correct booking with
spell-back, "feels like a person answered") and a Settings toggle for `voiceBrain` — the API accepts it today,
the dashboard does not yet render it.

### V7 ZERO-BUDGET DOCTRINE (founder law, 2026-08-01 — supersedes any paid recommendations above)
**NO money is spent until clients pay. Free tiers only; API costs become per-client pass-through at pilot signing (client's key or client-billed usage).**
- **TTS PRIMARY: Fish Audio S2.1 Pro** — founder's key is in `.env` as **`FISH_AUDIO_API=`** (use this EXACT var name in config.js). Free API (fair use). P0: measure real streaming TTFB, test Arabic quality with a stock voice, AND test whether 15s voice cloning works on the free key (if gated → best stock Arabic voice now, clone at first paid client). FALLBACKS: ElevenLabs free tier (20k chars/mo — demo-only budget, no cloning on free) → Gemini native audio (last resort).
- **Azure ar-TN/ar-LY:** parked (needs Azure signup; free 500k chars/mo but usually card-verified). Revisit at first client.
- **STT unchanged:** Deepgram $200 signup credit (≈690h, effectively free, card-free) primary → Speechmatics 50h/mo free fallback. Founder signs up when P0 asks.
- **LLM — NO paid key. Free failover chain replaces it:** `gemini flash-lite (free, thinking OFF)` → `Cerebras (1M tok/day free)` → `Groq (free)` → classic. Rotation on 429/quota — quota exhaustion must trigger the NEXT provider, never silent classic degradation (kills the "bad replies" root cause without spending). Waterfall log names the answering provider every turn. Derja few-shot pack applies to ALL providers; founder ear-grades the A/B sheet.
- **Cost surfacing for the future:** per-tenant usage metering (STT min / LLM tokens / TTS chars) logged from day one so pass-through billing is one config away.

### P0 MEASURED RESULTS (2026-08-01, this machine, Tunisia→providers)
Real API calls, throwaway probes (deleted), no money spent. Method for every row: **1 warm-up run excluded**,
then **8 measured runs** (**4** for Gemini Live, quota-sensitive), median + p95 reported. All measured runs
reuse a warm keep-alive connection; the cold-connection cost is called out separately. Free-tier keys only.

#### Layer: TTS
TTFB = request start → **first byte of response body** (i.e. first playable audio), not header time.

| Provider / mode | Model + headers that actually worked | median TTFB | p95 TTFB | Cold (1st) | Notes |
|---|---|---:|---:|---:|---|
| **Fish Audio — stock voice, mp3** | header `model: s2.1-pro-free`, JSON body `{text, format:'mp3', latency:'balanced'}` | **598 ms** | 978 ms | 633 ms | ~4.4 s of audio per 50-char sentence; full generation 2.6 s median (RTF ≈ 1.7×) |
| **Fish Audio — stock voice, pcm** | same, `format:'pcm'` | **597 ms** | 1068 ms | 759 ms | `sample_rate` **is honoured** — `8000` returns G.711-ready PCM, so **no resampling in the RTP path** |
| **Fish Audio — clone, reference uploaded per request** | `Content-Type: application/msgpack`, `references:[{audio:<raw bytes>, text}]`, 15 s ref | 1430 ms | 1746 ms | 1784 ms | **+858 ms** vs stock — the 240 KB reference is re-uploaded every turn. Do NOT ship this shape. |
| **Fish Audio — clone, pre-created voice model** | `POST /model` (multipart, `train_mode:fast`) → `reference_id` in a plain JSON TTS body | **572 ms** | 929 ms | 1622 ms | **Same TTFB as stock.** Model trained in 4.2 s, returned `state:"trained"`, `languages:["ar"]`. This is the shippable clone path. |
| **ElevenLabs Flash v2.5** | `xi-api-key`, `/stream?output_format=pcm_24000&optimize_streaming_latency=3`, `model_id: eleven_flash_v2_5` | **174 ms** | 180 ms | 184 ms | Fastest by 3.4×, and the tightest spread on the board (146–180 ms). Full generation 426 ms for 2.55 s of audio (RTF ≈ 6×). |
| **Gemini native audio (incumbent)** | `wss://…BidiGenerateContent?key=`, `gemini-2.5-flash-native-audio-latest`, `responseModalities:['AUDIO']` | **1969 ms** | 2042 ms | 1922 ms | setupComplete → first `inlineData` chunk. Brain **and** mouth in one number. Connect+setup costs a further 442 ms median (paid once per call). |
| Azure `ar-TN`/`ar-LY` | — | — | — | — | **Not measured** — parked per doctrine (needs Azure signup). |

**Free-tier walls hit (TTS):**
- **Fish paid models are hard-gated:** `s2.1-pro`, `s2-pro`, `s1`, `speech-1.6` all return **402 `Insufficient API credit`** (wallet credit `0`). **Only `s2.1-pro-free` works.** The `model:` request header is required and is the *only* selector.
- **Fish cloning is NOT gated on the free key — but JSON is.** `references:[{audio:<base64>}]` over `application/json` → **400 `Reference Audio is not valid`**. The identical payload as **msgpack with raw bytes** → **200 + audio**. **Verdict: on-the-fly 15 s cloning WORKS on the free key; msgpack is mandatory.** (A ~35-line inline encoder covers the whole body — no dependency needed.) Creating a persistent voice model from the same 15 s clip also works on the free key.
- **ElevenLabs free tier is 10 000 chars/month, not 20 000** — measured live from `/v1/user/subscription` (`tier:"free"`, `character_limit:10000`). At ~150 chars per spoken reply that is **≈65 replies for the entire month**, i.e. under 10 real calls. Free tier is also non-commercial and has no instant voice cloning. `pcm_24000` is **not** gated (it streams fine on free).

**Recommendation — TTS: Fish Audio `s2.1-pro-free` is PRIMARY, via a pre-created `reference_id`.**
It misses the doctrine's ~400 ms bar (572 ms median, 929 ms p95), and ElevenLabs is genuinely 3.4× faster
with a far tighter tail — but ElevenLabs' free tier cannot carry a pilot at all: 10 k chars/month is a demo,
not a receptionist, and it forbids both commercial use and cloning. Fish is fair-use free, its Arabic clone
path is **verified working on this key**, and `sample_rate: 8000` deletes the resample stage from the RTP
path outright. The ~400 ms we concede is bought back in the orchestrator, not the vendor: chunk at the first
clause so only the *opening* fragment pays TTFB, and keep the cached filler clip armed at 700 ms (already in
the V7 architecture). Even at Fish's number the cascade lands at **≈1.2 s brain-to-first-audio vs Gemini
Live's 1.97 s — a 775 ms win before STT is even counted.** ElevenLabs stays wired as the #2 provider for
founder demos and as the latency ceiling we measure ourselves against; Gemini native audio drops to last-resort.
**Ship rule:** never upload the reference per request (+858 ms) — clone once at onboarding, store `reference_id` per tenant.

#### Layer: LLM (voice turn, streaming, thinking off)
Realistic turn: 2-line receptionist persona system prompt + «نحب نحجز موعد قلب الجمعة الصباح», `maxOutputTokens: 80`.
TTFT = request start → first non-thought text token.

| Model (alias → what it actually resolves to) | median TTFT | p95 TTFT | median tok/s | Free-tier quota (measured) | Notes |
|---|---:|---:|---:|---|---|
| **`gemini-flash-lite-latest`** → `gemini-3.5-flash-lite` | **623 ms** | **698 ms** | 471 | **no wall hit** in ~50 calls | Tight spread (568–698 ms). The only candidate that never rate-limited under sustained load. |
| `gemini-3-flash-preview` → `gemini-3-flash` | 906 ms | 1075 ms | 323 | **5 requests/min** (recovers in ~20 s) | Added mid-P0 as the *free-tier-viable* Flash-class contender. +283 ms vs Flash-Lite. 5 RPM is ~5 turns/min across ALL tenants — a hard concurrency ceiling. |
| `gemini-flash-latest` → `gemini-3.6-flash` | 1103 ms | 1763 ms | 236 | **20 requests/DAY** | **p95 is 2.5× worse** — and p95 is what ends calls. Quota did not recover across 14 min of retries at 90 s intervals ⇒ daily, not a rolling window. |
| Cerebras | — | — | — | — | **SKIP — awaiting founder signup** (no key present). 1M tok/day free. |
| Groq | — | — | — | — | **SKIP — awaiting founder signup** (no key present). |

**Free-tier walls hit (LLM):**
- **`thinkingConfig.thinkingBudget: 0` is REJECTED — HTTP 400 `INVALID_ARGUMENT` — on both `-latest` aliases.** They now resolve to Gemini 3.x, which takes **`thinkingConfig.thinkingLevel`** instead. `'minimal'` and `'low'` are both accepted; `'minimal'` was used for every measurement and `usageMetadata.thoughtsTokenCount` came back **0**, confirming thinking really is off. **The V7 architecture line saying "thinkingBudget: 0" is stale — P1 must use `thinkingLevel`.**
- **`gemini-flash-latest` free quota is 20 requests per DAY** (`generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash`). It 429'd partway through the 10-question grading sheet and **never recovered** across 14 minutes of retries at 90 s intervals, which is how we know it is a daily cap and not a rolling window. Twenty requests a day is roughly **four phone calls** — this alone disqualifies it as a zero-budget primary, independent of quality.
- **`gemini-3-flash-preview` is 5 requests/minute** — recovers in ~20 s, so it is workable, but 5 RPM is a global ceiling across every tenant. Any cascade using it needs the rotation chain armed from turn one.
- **`gemini-2.5-flash` returns 404** ("no longer available to new users") and **`gemini-2.0-flash` free quota is literally 0**. Do not hardcode 2.x anywhere; pin a 3.x id or the `-latest` aliases.
- `gemini-3.5-flash` intermittently returns **503 "high demand"** on free tier — never a primary.
- Gemini Live native audio ran 5 clean sessions on the free tier with no quota complaint.

**Recommendation — LLM: `gemini-flash-lite-latest` is PRIMARY, with `thinkingLevel:'minimal'`.**
It wins every latency axis that matters (283 ms faster than the next viable model at the median, 480 ms faster
than Flash, **1065 ms faster than Flash at p95**, 2× throughput) *and* it is the only candidate that never hit a
free-tier wall under sustained load — which under this doctrine is not a tiebreaker but a gate. Flash's p95 of
1763 ms would blow the ≤1.2 s felt-latency acceptance on the LLM leg alone, before STT, TTS or network, and its
20-requests-per-day cap means it could not serve a single clinic-day even if it graded perfectly. The one open
question is naturalness — Flash's sample reply («يعيشك سيدي، مرحبة بيك…») is noticeably more Tunisian than
Flash-Lite's more MSA-flavoured («مرحباً بك…») — which is what `docs/P0-DERJA-SHEET.md` exists to settle.
Because Flash could not be graded on more than 3 of 10 questions, **`gemini-3-flash-preview` was added to that
sheet as row B** so the founder still gets a complete head-to-head against a model we could actually ship.
**If the founder scores B materially higher on the Derja axis, the fix is to ship the V7 few-shot pack on
Flash-Lite, not to promote B** — B costs +283 ms every turn and caps the whole product at 5 turns/minute.
Rotation chain for P1: `flash-lite → 3-flash-preview → Cerebras → Groq → classic`, with the answering provider
named in the waterfall log every turn. Cerebras and Groq remain unbenchmarked and therefore cannot be primary
under the doctrine; wire them as rotation targets once the founder signs up, and re-run this table.

#### Layer: STT
**Not measured — no key.** Deepgram Nova-3 `ar-TN` and Speechmatics both require a founder signup that has
not happened yet. This is the **single blocking dependency for P1**: the cascade cannot be assembled, let
alone A/B'd against `VOICE_BRAIN=live`, without a streaming STT leg. Everything downstream of it is now measured.

**Recommendation — STT: founder signs up for Deepgram (card-free, $200 credit ≈ 690 h) before P1 starts**, and
this subsection gets a row on the same 8-run method. Until then the measured brain-to-first-audio budget is
**LLM 623 ms + TTS 572 ms ≈ 1.2 s** (Fish) or **≈0.8 s** (ElevenLabs), against Gemini Live's **1.97 s** — so the
V7 cascade thesis holds on measured numbers, and STT + VAD is the only unknown left in the waterfall.

#### Artifacts + side effects
- `data/runtime/p0-fish-stock-ar.mp3` — Fish stock Arabic voice, derja sentence (founder ear test)
- `data/runtime/p0-fish-ref-15s.mp3` — the 15 s reference clip used for the clone test
- `data/runtime/p0-fish-clone-test.mp3` — cloned output, reference uploaded per request (msgpack)
- `data/runtime/p0-fish-clone-model.mp3` — cloned output via pre-created `reference_id` (the shippable path)
- `data/runtime/p0-eleven-ar.mp3` — ElevenLabs Flash v2.5 stock voice, same sentence
- `docs/P0-DERJA-SHEET.md` — 10-question derja grading sheet, Flash-Lite vs Flash, awaiting the founder's grade
- **Side effect on the founder's Fish account:** one private voice model `OMEN-P0-TEST-derja`, id
  `b5390e1a1ca542dfa80d9fed13a76581`, trained from the placeholder 15 s clip. Free, harmless — delete it or
  overwrite it when the real consented Tunisian sample is recorded.
- ElevenLabs free-tier consumption for this entire bake-off: **198 / 10 000 chars**.

## V7-P2.1 — DOUBLE-REPLY BUG (founder live test 2026-08-02: "two replies — the first finishes, then a second dictates another reply")
Signature = TWO TURNS answering ONE caller utterance, sequentially. The RTP-out path has two permitted writers somewhere. Ranked suspects — instrument FIRST, then fix:
1. **Speculative turn promoted AND final turn generated:** the speculation plays to the wire, then the final transcript triggers a fresh turn instead of recognizing the utterance was already answered. Check turn-ledger: one utterance-id must map to exactly one spoken reply.
2. **Double turn-end firing:** STT final event + endpointing/VAD both signal end-of-utterance → two generations queued. Debounce: single turn-end per utterance-id.
3. **liveEars still has a mouth:** if the Gemini Live session used as fallback ears isn't muted (response modality not restricted / its audio still enqueued), cascade answers AND Live answers. Ears must be EARS ONLY — assert no audio frames from liveEars ever reach RTP.
4. **A/B harness double-running brains on a live call** — A/B must replay recorded turns offline, never run two brains on one live call.
FIX REQUIREMENTS: (a) single-writer invariant — one speakGen owns RTP-out; any enqueue not holding the current gen is dropped and logged; (b) utterance ledger — turn-end debounced, one reply per utterance-id, asserted in tests; (c) waterfall log tags every audio-out chunk with source (cascade|speculative|live|greeting) so the next field test is attributable; (d) golden test reproducing the double-reply (fake STT emitting interim-stable + final for the same utterance; fake slow TTS) proving exactly one reply plays.
ACCEPTANCE: 10-turn live call — exactly one reply per caller utterance, zero self-triggering, confirmed from the tagged waterfall.

### STATUS 2026-08-02 — SHIPPED (code + tests green; the acceptance call is still owed)

**THE EVIDENCE (instrumented call, source-tagged RTP-out).** The tags found it in one call:

```
[rtp-out] src=spec utt=4 frames=24 (480ms)                 ← a GUESS reached the wire
[rtp-out] killed 50 queued frames (barge_in): {"spec":50}
Error: barge_in
  at killSpeech (orchestrator.js:670) ← noteEnergy (962) ← onRtp ← werift
  → uncaughtException (fromPromise)                        ← the PROCESS died mid-call
barge-in #3 / #4: killed 0 queued frames                   ← the energy trigger firing into silence
```

**THE TWO WRITERS, NAMED.**
1. **The speculative turn.** Its audio played as it was generated; the final's turn then answered the
   same utterance again, sequentially. That is the founder's "the first finishes, then a second
   dictates another reply", exactly.
2. **The endpointer, with no model behind it.** Deepgram sends `speech_final` with the words and
   `UtteranceEnd` on a LATER frame. The second one found the utterance already consumed and spoke the
   V6.2 "sorry, it is noisy" line straight over a perfectly good answer — a second reply that never
   touched an LLM.

**FIXES SHIPPED** (`src/voice-call/brain-cascade/orchestrator.js` unless noted):
- **(a) Single-writer speakGen on RTP-out.** Every frame — greeting, filler, turn, promoted guess,
  emergency, replayed tape — goes through one door (`pushFrames`) holding the generation it was made
  under; anything stale is dropped, logged (`[rtp-out] dropped N frames: stale gen (src=… utt=…)`) and
  counted (`stats.staleFramesDropped`). The emergency writer is the ONE documented exemption, matching
  the cancellation exemption it already had.
- **Speculation is PREPARE-ONLY.** The model streams and the mouth pre-warms, but audio is HELD (raw
  PCM, un-encoded) and the transcript rows with it. On promotion the held audio flushes atomically
  under the current generation and is tagged `turn`; **no frame is ever tagged `spec` again** —
  `outBySrc.spec === 0` is now an invariant, asserted per test. A guess that misses is discarded
  unheard: it costs the caller 0 ms, leaves no transcript row and no assistant line in the context.
- **(b) Utterance ledger + debounced turn-end.** `uttId → {answered, generations, revokedBy, turnEndAt}`.
  One reply per utterance ever; a second turn-start is refused and counted (`stats.ledgerRefused`).
  `speech_final`, the flush frame and the EOT timer collapse into ONE turn-end
  (`voiceCascadeTurnEndDebounceMs`, default 250 ms, `stats.turnEndsDebounced`) — but only when nothing
  new was heard in between, so a fast real second turn is never eaten. The drift restart is the one
  legitimate second generation: it revokes the answer (`revokedBy:'drift'`) under a `killSpeech` gen
  bump, and two generations per utterance is a hard cap.
- **(c) liveEars stays muzzled**, now asserted from the ORCHESTRATOR: 50 model `audio`/`text` events
  change `outBySrc` by nothing at all, and the echo drop is asserted at the adapter with the two
  predicates the orchestrator lends it.
- **(d) A/B harness cannot put two brains on a line.** `scripts/cascade-ab.js` refuses to start while
  the target app reports an active call, and re-asserts after every call it places; `GET /health` now
  reports `calls: {active, brains[]}` (counts and brain names only — it is a public endpoint). The
  script composes no brain at all: it imports one codec helper and otherwise speaks HTTP and RTP,
  and the server decides a call's brain once at pickup.
- **(e) The crash, root-caused.** A barge-in aborts the fetch, which **errors the response body
  stream**; per the streams spec `reader.cancel()` on an errored stream returns a promise already
  **rejected** with the stored error. `brain/tts/wire.js` (and `brain-cascade/llm/http.js`) called it
  for its side effect inside a *synchronous* try/catch, which cannot catch a rejection — so the abort
  reason escaped as an unhandled rejection and Node escalated it to a fatal exception out of the RTP
  path. Both call sites now observe the promise (`settle()`); the abort reason is a tagged error
  (`speechAbortReason`) and every controller is aborted through `abortQuietly`.
- **(f) Energy barge gate**, re-checked where it fires (`outQueue || tapePending || speechInFlight`),
  with an honest log (frames queued + utterances in flight) and `stats.energyBargeSilent` for the
  fired-into-silence case.

**TESTS** (12 new, whole suite green): golden promotion (one reply, `outBySrc.spec === 0`, ledger
`{answered, generations:1}`, zero stale frames); golden drift variant (answer un-said, ONE new reply,
`generations:2`, `revokedBy:'drift'`); a guess that misses reaches neither wire nor transcript nor
context; ledger refusal; the `UtteranceEnd` flush that must not speak, plus the real-second-turn case
it must not eat; **process-level `unhandledRejection` assertions** on both the orchestrator barge-in
and the exact `cancel()`-rejects wire shape (verified to fail before the fix); the energy gate on a
silent wire; liveEars muzzle + echo drop.

**ACCEPTANCE (still owed): 10-turn live call — one tagged reply per utterance**, read off the
`[rtp-out] src=…` lines: every reply tagged `turn` (or `greeting`/`filler`/`emergency`), never `spec`,
`ledgerRefused`/`turnEndsDebounced` explaining any suppression, and `staleFramesDropped === 0`.

## V8 — MONDAY DEMO WAR PLAN (founder sells in person Monday; this is the ONLY active voice work order until then)
Verdict from war-room code audit + leader research (Sesame/GPT-Live/ElevenLabs/Vapi/Retell playbooks, sourced in war-room log): pipeline bones are correct (deterministic gate, guaranteed filler, language lock = leader consensus) but the turn system is antique and one open bug is demo-fatal. Real measured turns: VAD 702–1442ms + LLM ~850ms + TTS ~570ms ≈ 2.2–2.5s felt with high jitter. Target for Monday: ≤1.3s felt, ZERO double-replies, interruption-proof. Execute in THIS order — stop gold-plating anything else:

### D1 — THE BLOCKER (do first, nothing else until green): implement V7-P2.1
Single-writer speakGen on RTP-out · utterance ledger (ONE reply per utterance-id, turn-end debounced across STT-final vs endpointer) · liveEars muzzled ears-only with assertion · A/B harness can NEVER run two brains on a live call. Golden test reproduces the double reply and proves one plays. This bug alone loses Monday.

### D2 — LATENCY: cut the wait, kill the jitter
1. Endpointing: default end-of-speech ~400ms (from measured 700-1400) — EXCEPT data-capture states (phone/name/date collection) which switch to PATIENT mode ~900ms (callers pause mid-digit; leaders all do state-dependent eagerness). State comes from the booking gate — we know when we're capturing.
2. Jitter: log and clamp — if TTFT variance persists, pin provider order (skip cold providers), pre-warm connections per call (open Fish WS + LLM keepalive at call accept, not first turn).
3. Filler threshold 700ms stays; ADD guaranteed request-start lines on EVERY tool/executor call ("ثانية نشوفلك الرندي فو…") — silence during lookups is the #1 robot tell (leader consensus).

### D3 — INTERRUPTION-PROOF (the Tunisian caller reality)
1. Barge-in word-gate: RMS trigger alone is banned — require ~2+ words of real speech (STT interim confirms) before yielding; EXCEPT emergency keywords = instant yield (numWords 0).
2. Backchannel ignore-list: أيوا · تمام · باهي · مم · هاو · oui · ok · mm-hmm — these NEVER stop the agent mid-sentence.
3. Never end a turn on a fragment; on caller silence 10-15s → ONE warm check-in → polite goodbye + WhatsApp follow-up (existing degrade path).

### D4 — HUMAN POLISH (prompt-level, 2h, from the leader playbook)
Acknowledge→answer→ONE question per turn (end every turn with the question) · anti-repetition rule (never same phrasing twice in a call) · restrained disfluency vocabulary for clinical warmth ("نشوف…", "ثانية برك", "أممم" sparingly — 1-2 per turn max, never on emergency/confirmation turns) · spoken-forms rule (digits read as words, dates spoken naturally) · read-backs ONLY for exact data · pace: slightly slower TTS rate for elderly-sounding callers if provider supports rate.

### D5 — DEMO-DAY PROTOCOL (docs/DEMO-DAY.md — write it)
1. Pre-visit ritual (30 min before EVERY visit): fresh token if >20h old, tunnel up, webhook re-pointed, subscribed_apps re-POSTed, ONE test call + one test chat message. Scripted checklist, single command where possible (`npm run demo:preflight` — build it: checks token validity, tunnel health, subscription, prints GO/NO-GO).
2. Demo runbook: chat demo FIRST (bulletproof: voice note → booking → owner alert on the doctor's own eyes), THEN the voice call as the closer — founder places the call on speaker, follows the rehearsed 90-second flow (greeting → book cardiology Thursday morning → spell-back → confirmed + WhatsApp summary appears live). NEVER hand the phone to the doctor for a free-form first call.
3. Fallback chain: voice fails → "let me show you the recording" (founder records tonight's best call as backup video) → chat demo carries the meeting. The pitch is the SYSTEM (chat+voice+dashboard), not one channel.
4. Rehearse: founder runs the full demo flow 5× before Monday; every failure feeds a fix.

### Acceptance (Sunday night): 10 rehearsal calls — zero double-replies, felt latency ≤1.3s median with no turn >2s, agent survives أيوا/تمام backchannels without stopping, booking lands with correct spell-back, preflight script prints GO. Then STOP CODING and sleep.
