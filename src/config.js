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
    // ── the talking brain (V2 voice tier) ──────────────────────────────────
    // 'brain' = Gemini Live realtime loop (per-tenant persona, KB grounding,
    //           deterministic booking gate, our own emergency detector).
    // 'echo'  = V1 behaviour: the audio path is held open and echoed, the bot
    //           says nothing. Automatic without a Gemini key — a clinic must
    //           never get a mute call because someone forgot to set a flag.
    voiceCallMode: process.env.VOICE_CALL_MODE || (process.env.GEMINI_API_KEY ? 'brain' : 'echo'),
    // Native-audio Live model. Rolling alias on purpose: a pinned model that
    // gets retired silently muted the chat engine once already (see geminiModel).
    geminiLiveModel: process.env.GEMINI_LIVE_MODEL || 'gemini-live-2.5-flash-native-audio',
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
