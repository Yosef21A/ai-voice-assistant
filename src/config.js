// Central configuration + a tiny zero-dependency .env loader.
// No external packages: we parse `.env` by hand so the only runtime dependency
// stays "express" (and even that is optional for the CLI/tests).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
export const CLINICS_FILE = path.join(DATA_DIR, 'clinics.json');

// Minimal .env parser. Only sets keys that are not already in process.env,
// so real environment variables always win.
function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

/**
 * Build the runtime config object. Accepts overrides (used by simulate/tests
 * so they can point at an isolated runtime directory).
 * @param {object} [overrides]
 */
export function getConfig(overrides = {}) {
  return {
    port: Number(process.env.PORT) || 3000,
    whatsappToken: process.env.WHATSAPP_TOKEN || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'omen-verify-dev',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '1000000001',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    // gemini-flash-latest = the rolling current flash. The pinned gemini-2.5-flash
    // was retired for new API keys (404 "no longer available to new users"),
    // which silently degraded every LLM turn to classic/mock — always prefer a
    // rolling alias here so a model retirement can't take the bot offline again.
    geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS) || 8000,
    // ── conversation mode (P2-HUMANIZE) ────────────────────────────────────
    // 'llm'     = LLM-led dialogue (Gemini structured output) with the
    //             deterministic executor + guardrails.
    // 'classic' = the scripted state machine (offline demo + automatic
    //             fallback whenever the LLM times out or errors).
    // Default: llm when a Gemini key is present, else classic. The engine
    // additionally requires the provider to support structured output, so a
    // mock provider always runs classic regardless of this flag.
    conversationMode:
      process.env.CONVERSATION_MODE || (process.env.GEMINI_API_KEY ? 'llm' : 'classic'),
    // Outbound WhatsApp transport: 'real' | 'mock' | '' (auto: token ⇒ real).
    // Tests pin 'mock' so a developer's .env token can never leak network calls.
    whatsappTransport: process.env.WHATSAPP_TRANSPORT || '',
    // ── dashboard auth + API (Phase 1, Slice C) ─────────────────────────────
    // APP_SECRET signs the HMAC session cookies (src/auth). It is DISTINCT from
    // WHATSAPP_APP_SECRET (that one verifies Meta's inbound webhook signature).
    // A dev default keeps the offline demo/tests working; production MUST set a
    // strong value (see .env examples: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
    sessionSecret: process.env.APP_SECRET || 'omen-dev-session-secret-change-me',
    // Cookies are marked Secure automatically in production (behind Nginx TLS);
    // force it on/off with COOKIE_SECURE=1|0 when needed.
    cookieSecure:
      process.env.COOKIE_SECURE != null
        ? process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true'
        : process.env.NODE_ENV === 'production',
    // Session lifetime (sliding) and SSE heartbeat cadence, both in ms.
    sessionTtlMs: Number(process.env.SESSION_TTL_MS) || 7 * 24 * 60 * 60 * 1000,
    sseHeartbeatMs: Number(process.env.SSE_HEARTBEAT_MS) || 25000,
    // ── storage (Phase 1) ──────────────────────────────────────────────────
    // Zero-config default is the JSON file store (offline, single-process).
    // Set DATABASE_URL to target Postgres (migrate/seed scripts + the async
    // adapter interface). STORE can force 'json' | 'postgres' explicitly.
    // These are surfaced for the composition layer to pass into createStore();
    // the factory itself selects only from EXPLICIT opts (see src/store/README.md).
    databaseUrl: process.env.DATABASE_URL || '',
    store: process.env.STORE || '',
    // ── inbound media (P2-D) ───────────────────────────────────────────────
    // X-rays/documents/voice notes land under mediaDir/{tenantId}/{yyyymm}/.
    // The cap is a product decision (10MB default); retention feeds the purge
    // script (scripts/purge-media.js) — patient data must be erasable.
    mediaDir: process.env.MEDIA_DIR || path.join(DATA_DIR, 'media'),
    mediaMaxBytes: Number(process.env.MEDIA_MAX_BYTES) || 10 * 1024 * 1024,
    mediaRetentionDays: Number(process.env.MEDIA_RETENTION_DAYS) || 90,
    // ── voice-note understanding (V1) ──────────────────────────────────────
    // Still gated twice on top of this flag: the tenant must be in llm mode AND
    // the provider must implement transcribeAudio() (MockProvider deliberately
    // does not). VOICE_STT=off kills it instantly if a clinic burns quota.
    // The "≤ 2 min" rule is enforced on BYTES — the Cloud API audio object
    // carries no duration (see src/voice/policy.js).
    voiceStt: process.env.VOICE_STT !== 'off',
    voiceMaxSeconds: Number(process.env.VOICE_MAX_SECONDS) || 120,
    voiceSttTimeoutMs: Number(process.env.VOICE_STT_TIMEOUT_MS) || 15000,
    voiceSttDeadlineMs: Number(process.env.VOICE_STT_DEADLINE_MS) || 22000,
    voiceMinConfidence: Number(process.env.VOICE_MIN_CONFIDENCE ?? 0.5),
    voiceMaxTranscriptChars: Number(process.env.VOICE_MAX_TRANSCRIPT_CHARS) || 1500,
    voiceBreakerThreshold: Number(process.env.VOICE_BREAKER_THRESHOLD) || 3,
    voiceBreakerCooldownMs: Number(process.env.VOICE_BREAKER_COOLDOWN_MS) || 60000,
    // ── appointment reminders (V2 no-show killer) ──────────────────────────
    // Scheduler cadence; 0 disables the timer entirely (tests drive tick()
    // directly). Per-tenant kind toggles live in tenant config `reminders`.
    // Out-of-window reminders are logged, never sent — the compliant template
    // path ships with the production number (P2-H / RUNBOOK §E).
    remindersIntervalMs:
      process.env.REMINDERS_INTERVAL_MS != null
        ? Number(process.env.REMINDERS_INTERVAL_MS) || 0
        : 60000,
    // ── smart follow-ups (V4) — one nudge per conversation, ever ───────────
    followupsIntervalMs:
      process.env.FOLLOWUPS_INTERVAL_MS != null
        ? Number(process.env.FOLLOWUPS_INTERVAL_MS) || 0
        : 5 * 60 * 1000,
    // ── WhatsApp calls (V1 voice tier) ─────────────────────────────────────
    // Inbound calls ride the SAME webhook as messages (change.field === 'calls').
    // VOICE_CALLS=off unwires the whole thing at composition time — nothing is
    // constructed, no UDP socket can ever be opened. Sockets are only opened on
    // an actual connect event, never at boot, so the offline demo is unaffected.
    voiceCalls: process.env.VOICE_CALLS !== 'off',
    // 'real' | 'mock' | '' (auto: WHATSAPP_TOKEN ⇒ real). Point the graph base at
    // the local harness (scripts/call-harness.js) to exercise real WebRTC media
    // without Meta: VOICE_CALL_GRAPH_BASE=http://localhost:3901.
    voiceCallTransport: process.env.VOICE_CALL_TRANSPORT || '',
    voiceCallGraphBase: process.env.VOICE_CALL_GRAPH_BASE || '',
    // Meta drops an unanswered call at ~30-60s; we give media 20s to connect,
    // then hang up ourselves rather than hold a UDP socket on a dead call.
    voiceCallConnectTimeoutMs: Number(process.env.VOICE_CALL_CONNECT_TIMEOUT_MS) || 20000,
    // Hard cap on a single call (cost + stuck-session insurance).
    voiceCallMaxSec: Number(process.env.VOICE_CALL_MAX_SEC) || 600,
    // THE HANG-UP BELT (V5-T2). When the agent calls end_call we wait for its
    // farewell to actually reach the wire before dropping the line — cutting
    // "بالسلامة" in half is a worse tell than the bug it fixes. This is the
    // ceiling on that wait: a farewell that never arrives (a dead TTS provider,
    // a model that called the tool and then said nothing) must not leave the
    // caller holding an open line, which is the exact failure end_call exists
    // to remove. Found on a live call: the agent NEVER hung up.
    voiceCallHangupGraceMs: Number(process.env.VOICE_CALL_HANGUP_GRACE_MS) || 8000,
    // ── the talking brain (V2 voice tier) ──────────────────────────────────
    // 'brain' = Gemini Live realtime loop (per-tenant persona, KB grounding,
    //           deterministic booking gate, our own emergency detector).
    // 'echo'  = V1 behaviour: the audio path is held open and echoed, the bot
    //           says nothing. Automatic without a Gemini key — a clinic must
    //           never get a mute call because someone forgot to set a flag.
    voiceCallMode: process.env.VOICE_CALL_MODE || (process.env.GEMINI_API_KEY ? 'brain' : 'echo'),
    // Native-audio Live model. Rolling alias on purpose: a pinned model that
    // gets retired silently muted the chat engine once already (see geminiModel).
    // Rolling alias, SAME hard lesson as geminiModel above: a pinned preview id
    // dies out from under the product (the pinned default here 1008-closed the
    // very first live call, 2026-07-31 — verify candidates with
    // GET /v1beta/models and look for bidiGenerateContent).
    geminiLiveModel: process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-latest',
    // The brain has this long to answer the phone before we give up and degrade
    // to the WhatsApp follow-up. Dead air is the one outcome we refuse.
    voiceBrainConnectMs: Number(process.env.VOICE_BRAIN_CONNECT_MS) || 6000,
    // After the emergency script is dictated, how long before we hang up. The
    // Arabic script is the longest of the three and is read slowly on purpose;
    // 9s truncated it mid-number in review, so the floor is 12s.
    voiceBrainEmergencyGraceMs: Number(process.env.VOICE_BRAIN_EMERGENCY_GRACE_MS) || 12000,
    // Circuit breaker on the brain, mirroring the STT quota breaker
    // (src/voice/transcriber.js). A dead Gemini Live endpoint would otherwise
    // cost EVERY caller 6 seconds of silence before the degrade; after three
    // consecutive failures we skip straight to "we'll message you on WhatsApp"
    // and let one probe call through after the cooldown.
    voiceBrainBreakerThreshold: Number(process.env.VOICE_BRAIN_BREAKER_THRESHOLD) || 3,
    voiceBrainBreakerCooldownMs: Number(process.env.VOICE_BRAIN_BREAKER_COOLDOWN_MS) || 300000,
    // ── human-feel engineering (V5-T0) ─────────────────────────────────────
    // The greeting on tape: the first call of a tenant/language/codec records
    // its own greeting frames in memory, and every later call replays them the
    // instant media connects — dead air at pickup is the #1 "this is a robot"
    // tell. Personalized greetings are never cached and never served from the
    // cache. VOICE_GREETING_CACHE=off falls back to generating every greeting.
    voiceGreetingCache: process.env.VOICE_GREETING_CACHE !== 'off',
    // Endpointing patience. Callers pause mid-sentence — a date read off a
    // paper, an older caller in Derja — and the Live API's default end-of-speech
    // detection cuts them off, which reads as rude and produces half-heard
    // bookings. ~1s of silence before we consider a turn finished, with LOW
    // end-sensitivity (= wait longer). VOICE_VAD_END_SENSITIVITY=off sends the
    // server's defaults instead, which is the escape hatch if the API's setup
    // shape ever changes under us (a rejected setup closes the socket and
    // degrades the whole call).
    voiceVadSilenceMs: Number(process.env.VOICE_VAD_SILENCE_MS) || 1000,
    voiceVadEndSensitivity: process.env.VOICE_VAD_END_SENSITIVITY || 'END_SENSITIVITY_LOW',
    voiceVadPrefixPaddingMs: Number(process.env.VOICE_VAD_PREFIX_PADDING_MS) || 60,
    // ── a better mouth (V5-T1) ─────────────────────────────────────────────
    // WHICH voice speaks on a call. '' (the default) keeps Gemini Live's own
    // native audio — free, and the only option that cannot be broken by a
    // vendor outage or an unpaid invoice. 'azure' | 'elevenlabs' switch the
    // Live session to TEXT and stream the words through a real TTS engine
    // (src/voice-call/brain/tts/). This is the GLOBAL default; a tenant
    // overrides it with `voice.provider` in Settings. A provider named without
    // its credential logs one warning and falls back to the native voice —
    // selling a voice upgrade must never be able to take a phone line down.
    voiceTtsProvider: process.env.VOICE_TTS_PROVIDER || '',
    // Azure Neural TTS: the only vendor with native ar-TN AND ar-LY voices,
    // which is the whole reason it is the first rung of the ladder.
    azureSpeechKey: process.env.AZURE_SPEECH_KEY || '',
    azureSpeechRegion: process.env.AZURE_SPEECH_REGION || 'westeurope',
    // ElevenLabs: the cloned-dialect voice (V5-T2). There is deliberately no
    // default voice id — a clone belongs to a person who consented, so it is a
    // per-tenant setting (`voice.elevenVoiceId`) or the provider is not used.
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
    // CROSS-CALL BREAKER on the TTS vendor, mirroring the brain breaker above.
    // A vendor outage with VALID credentials would otherwise cost every single
    // caller the same doomed sequence — open a TEXT session, greet, fail the
    // first synthesis, hang up — for as long as it lasted, while the native
    // Gemini voice sat there working. After two calls lost to the same
    // provider we compose the native voice instead, and let ONE probe call
    // through after the cooldown to find out whether the vendor came back.
    voiceTtsBreakerThreshold: Number(process.env.VOICE_TTS_BREAKER_THRESHOLD) || 2,
    voiceTtsBreakerCooldownMs: Number(process.env.VOICE_TTS_BREAKER_COOLDOWN_MS) || 300000,
    // ── THE FAST CASCADE (V7) ──────────────────────────────────────────────
    // WHICH BRAIN answers a call:
    //   'live'    = the incumbent Gemini Live S2S loop (brain/). Measured 1.97 s
    //               to first audio — slowest of its class, and the reason V7
    //               exists. It stays the DEFAULT until the cascade has been
    //               A/B'd on real calls (P2), and stays forever as the fallback.
    //   'cascade' = brain-cascade/: streaming STT → text LLM → streaming TTS,
    //               overlapped. Measured budget ≈1.2 s brain-to-first-audio.
    // Anything unrecognized means 'live', the same rule voiceCallMode uses: an
    // unrecognized value must never silently enable the experimental path.
    voiceBrain: process.env.VOICE_BRAIN || 'live',
    // TTS PRIMARY under the zero-budget doctrine. The founder's key is in .env
    // under this EXACT name — FISH_AUDIO_API, not FISH_API_KEY.
    fishAudioApi: process.env.FISH_AUDIO_API || '',
    // STT. Both are key-gated: the adapters exist, and without a key the chain
    // falls through to liveEars (a Gemini Live session used ONLY as ears) and
    // then to the degrade-to-chat path. Deepgram is the primary the moment the
    // founder signs up (card-free, $200 credit ≈ 690 h).
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
    speechmaticsApiKey: process.env.SPEECHMATICS_API_KEY || '',
    // LLM rotation targets. Both free tiers, both OpenAI-compatible, both
    // UNBENCHMARKED on derja — which is why they are rotation targets and never
    // the primary (doctrine: nothing unbenchmarked on derja ships as primary).
    cerebrasApiKey: process.env.CEREBRAS_API_KEY || '',
    groqApiKey: process.env.GROQ_API_KEY || '',
    // ── cascade tunables ───────────────────────────────────────────────────
    // How long after a final transcript we wait for more speech before deciding
    // the caller finished. The single biggest latency line item per Vapi/Pipecat
    // data; 250–400 ms is the band, and the STT's own `speech_final` short-cuts
    // it whenever the vendor is confident.
    //
    // V8-D2: 400 ms is the founder's measured call (VAD 702–1442 ms felt), and
    // it is the DEFAULT — not the only value. See voiceCascadeEotPatientMs.
    voiceCascadeEotMs: Number(process.env.VOICE_CASCADE_EOT_MS) || 400,
    // …EXCEPT while the agent is collecting data (a phone number, a name, a day
    // and time). Callers pause mid-digit, and cutting them off there does not
    // just sound rude — it books the wrong number. Every leader (Vapi, Retell,
    // ElevenLabs) ships state-dependent eagerness for exactly this turn.
    voiceCascadeEotPatientMs: Number(process.env.VOICE_CASCADE_EOT_PATIENT_MS) || 900,
    // Two consecutive interims sharing this many normalized characters of prefix
    // are stable enough to start the LLM on. Lower = more speculation (and more
    // wasted tokens); higher = more of the caller's pause spent silent.
    voiceCascadeSpecMinPrefix: Number(process.env.VOICE_CASCADE_SPEC_MIN_PREFIX) || 12,
    // Beyond this without a first LLM token, the caller hears a cached filler
    // clip. Perceived latency is the metric: a filled 1.5 s feels instant, a
    // silent 900 ms feels broken.
    voiceCascadeFillerTtftMs: Number(process.env.VOICE_CASCADE_FILLER_TTFT_MS) || 700,
    // The barge-in budget: caller speaks over us ⇒ the wire must be quiet within
    // this. It is asserted in the suite, not merely hoped for.
    voiceCascadeBargeKillMs: Number(process.env.VOICE_CASCADE_BARGE_KILL_MS) || 150,
    // ── V8-D2: the pre-warm, and the jitter clamp ──────────────────────────
    // At ACCEPT time (not on the first turn) the call opens the primary LLM's
    // TLS/H2 connection and synthesizes the tenant's filler clip if the tape is
    // cold. Both are cheap and both are paid once instead of inside the first
    // turn the caller actually waits for. VOICE_CASCADE_PREWARM=off disables it
    // — the escape hatch if a free tier ever starts billing metadata reads.
    voiceCascadePrewarm: process.env.VOICE_CASCADE_PREWARM !== 'off',
    // A provider whose rolling median time-to-first-token passes this is COLD,
    // not broken: it is skipped for new turns (and probed occasionally) rather
    // than benched by the breaker. Jitter is what makes an agent feel unusable
    // even when the median looks fine. A deliberate 0 (or VOICE_CASCADE_TTFT_
    // CLAMP_MS=off) DISABLES the clamp — honoured rather than swallowed by a
    // `|| default`, so a mis-tuned threshold can be turned off from an env var.
    voiceCascadeTtftClampMs:
      process.env.VOICE_CASCADE_TTFT_CLAMP_MS != null
        ? Number(process.env.VOICE_CASCADE_TTFT_CLAMP_MS) || 0
        : 2000,
    // ── V8-D3: interruption-proofing (the Tunisian caller reality) ─────────
    // Words of real speech an interim must carry before it may stop the agent
    // mid-sentence. RMS energy alone NEVER yields any more — it is evidence,
    // and the ears are the confirmation. Emergency keywords bypass this
    // entirely (numWords 0). Set to 1 to restore the pre-V8 behaviour.
    voiceCascadeBargeMinWords: Number(process.env.VOICE_CASCADE_BARGE_MIN_WORDS) || 2,
    // …and the same floor for STARTING a turn: a one-word non-backchannel
    // final outside a data-capture state is a transcription fragment far more
    // often than it is a question. In a data-capture state it is real data (a
    // digit, a day) and the floor does not apply.
    voiceCascadeMinTurnWords: Number(process.env.VOICE_CASCADE_MIN_TURN_WORDS) || 2,
    // A bare «أيوا»/«تمام»/«ok» while the wire is QUIET is an acknowledgment,
    // not a question: it is recorded and answered with silence rather than
    // costing an LLM turn. Off ⇒ it becomes an ordinary turn (pre-V8).
    // While the agent is SPEAKING a backchannel is always immune, whatever this
    // says — that half is not a preference.
    voiceCascadeBackchannelAck: process.env.VOICE_CASCADE_BACKCHANNEL_ACK !== 'off',
    // Caller silence after our own turn: ONE warm check-in at this point, then
    // a polite goodbye + the WhatsApp follow-up after the second window. A line
    // held open on a caller who walked away bills for nothing and ends nowhere.
    // A deliberate 0 disables the ladder (a caller who goes quiet is left on the
    // line) — honoured rather than swallowed by a `|| default`.
    voiceCascadeSilenceCheckMs:
      process.env.VOICE_CASCADE_SILENCE_CHECK_MS != null
        ? Number(process.env.VOICE_CASCADE_SILENCE_CHECK_MS) || 0
        : 10000,
    voiceCascadeSilenceByeMs:
      process.env.VOICE_CASCADE_SILENCE_BYE_MS != null
        ? Number(process.env.VOICE_CASCADE_SILENCE_BYE_MS) || 0
        : 8000,
    // ── energy barge-in (V7-P2.1) ──────────────────────────────────────────
    // On the founder's first live cascade call the caller talked over the agent
    // repeatedly and barge-in fired ZERO times in 101 s: every path to the
    // kill-chain went through a transcript, and the transcripts were late,
    // empty or hallucinated. So the interruption test also runs on raw caller
    // ENERGY. Flagged because a badly tuned threshold on a noisy line would cut
    // the agent off mid-sentence, and that must be switchable from an env var.
    voiceCascadeEnergyBarge: process.env.VOICE_CASCADE_ENERGY_BARGE !== 'off',
    // RMS of a decoded 16 kHz frame (0…32767) that counts as speech. PCM16
    // silence on a mobile leg sits in the low hundreds; conversation is
    // thousands.
    voiceCascadeBargeRms: Number(process.env.VOICE_CASCADE_BARGE_RMS) || 1200,
    // How long that level must be SUSTAINED before it is an interruption. A
    // click, a cough or one loud packet does not survive 240 ms; a syllable does.
    voiceCascadeBargeRmsMs: Number(process.env.VOICE_CASCADE_BARGE_RMS_MS) || 240,
    // ── the double-reply fix (V7-P2.1) ─────────────────────────────────────
    // THREE things claim to know the caller stopped: the vendor's own
    // `speech_final`, its later `UtteranceEnd` flush frame, and our EOT timer.
    // Two of them landing inside this window are ONE endpoint firing twice —
    // and the second one used to speak ("sorry, it is noisy") straight over a
    // perfectly good answer. Collapsed into a single turn-end per utterance.
    voiceCascadeTurnEndDebounceMs: Number(process.env.VOICE_CASCADE_TURN_END_DEBOUNCE_MS) || 250,
    // ── the hang-up backstop (V8, self-test 2026-08-02) ────────────────────
    // `end_call` is the ONLY thing that releases a WhatsApp call — and on four
    // scored rehearsal runs in a row the model said its farewell and never
    // called it, so the line stayed open until the caller gave up. The caller's
    // OWN goodbye now arms a deterministic hang-up this long after our reply has
    // drained, with nothing pending. A model that calls end_call properly still
    // wins and still fires sooner; a deliberate 0 disables the backstop.
    voiceCascadeFarewellHangupMs:
      process.env.VOICE_CASCADE_FAREWELL_HANGUP_MS != null
        ? Number(process.env.VOICE_CASCADE_FAREWELL_HANGUP_MS) || 0
        : 3000,
    // ElevenLabs' free tier is 10 000 characters a MONTH (measured live from
    // /v1/user/subscription during P0) — about sixty-five spoken replies. It is
    // the #2 voice in the chain, so a Fish outage could drain the entire month
    // through the FALLBACK in one afternoon and the founder would discover it
    // mid-demo. Past this soft cap the fallback stops choosing it; a tenant who
    // named ElevenLabs explicitly is never blocked (they may be paying for it).
    voiceElMonthlySoftCap: Number(process.env.VOICE_EL_MONTHLY_SOFT_CAP) || 8000,
    // ── ops (P2-F) ─────────────────────────────────────────────────────────
    // One JSON line per request (skips /health). On in production; opt-in
    // elsewhere with LOG_REQUESTS=1 so tests/dev stay quiet.
    logRequests:
      process.env.LOG_REQUESTS === '1' ||
      (process.env.NODE_ENV === 'production' && process.env.LOG_REQUESTS !== 'off'),
    dataDir: DATA_DIR,
    runtimeDir: RUNTIME_DIR,
    clinicsFile: CLINICS_FILE,
    ...overrides,
  };
}
