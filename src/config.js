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
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
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
    dataDir: DATA_DIR,
    runtimeDir: RUNTIME_DIR,
    clinicsFile: CLINICS_FILE,
    ...overrides,
  };
}
