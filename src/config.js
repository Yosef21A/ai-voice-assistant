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
    // ── storage (Phase 1) ──────────────────────────────────────────────────
    // Zero-config default is the JSON file store (offline, single-process).
    // Set DATABASE_URL to target Postgres (migrate/seed scripts + the async
    // adapter interface). STORE can force 'json' | 'postgres' explicitly.
    // These are surfaced for the composition layer to pass into createStore();
    // the factory itself selects only from EXPLICIT opts (see src/store/README.md).
    databaseUrl: process.env.DATABASE_URL || '',
    store: process.env.STORE || '',
    dataDir: DATA_DIR,
    runtimeDir: RUNTIME_DIR,
    clinicsFile: CLINICS_FILE,
    ...overrides,
  };
}
