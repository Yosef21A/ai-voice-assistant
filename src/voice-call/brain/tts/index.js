// THE MOUTH (V5-T1). Gemini keeps the ears and the brain; this picks the voice.
//
//   mode 'native'  → the Live session answers in AUDIO and speaks for itself.
//                    This is today's stack, unchanged, and it is the default.
//   mode 'tts'     → the Live session answers in TEXT; loop.js buffers that text
//                    into sentences and streams each one through synthesize().
//
// THE SELECTION RULE, in one place so nobody has to guess:
//   1. `clinic.voice.provider` — the per-tenant setting (dashboard → Settings).
//   2. `config.voiceTtsProvider` (VOICE_TTS_PROVIDER) — the global default.
//   3. 'gemini' — native. Always the answer when nothing else applies.
// A provider whose CREDENTIAL is missing does not fail the call and does not
// fail loudly on every turn: it logs ONE warning naming the missing key, and the
// call runs on the native voice. Selling a voice upgrade must never be able to
// take the phone line down, and a clinic with a typo in its settings still
// answers its phone.
//
// WHAT HAPPENS WHEN A PROVIDER DIES MID-CALL — read this before changing it.
// The obvious design is "fall back to native for the rest of the call". It is
// not implementable, and the reason is worth writing down: `responseModalities`
// is part of the Live API's `setup` frame, the setup frame is sent exactly once,
// and the session is immutable afterwards. A session that was opened in TEXT
// mode will never produce audio, so there is no native voice to fall back TO
// without tearing the Live session down and rebuilding it mid-conversation
// (losing the whole dialogue state, and costing the caller several seconds of
// silence to do it). So the honest degrade is the one this product already has
// for a dead brain: stop talking, end the call politely, and hand the patient to
// the chat engine in writing. loop.js reports outcome reason 'tts_lost' and
// src/voice-call/index.js sends the SAME `callBrainLost` follow-up it sends when
// Gemini itself dies. A session restart mid-call is a real option — it is just a
// bigger slice than this one, and it is noted rather than half-built.
import { createAzureTts } from './azure.js';
import { createElevenLabsTts } from './elevenlabs.js';
import { TtsError, isTtsError, TTS_TIMEOUT_MS } from './wire.js';
import {
  isTtsBreakerOpen,
  DEFAULT_TTS_BREAKER_THRESHOLD,
  DEFAULT_TTS_BREAKER_COOLDOWN_MS,
} from './breaker.js';

export { TtsError, isTtsError, TTS_TIMEOUT_MS };
export { createAzureTts } from './azure.js';
export { createElevenLabsTts } from './elevenlabs.js';
export {
  noteTtsFailure,
  noteTtsOk,
  isTtsBreakerOpen,
  resetTtsBreakers,
  ttsBreakerStats,
  DEFAULT_TTS_BREAKER_THRESHOLD,
  DEFAULT_TTS_BREAKER_COOLDOWN_MS,
} from './breaker.js';

/** Everything a tenant is allowed to name. Validated again in api/tenant.js. */
export const TTS_PROVIDERS = new Set(['gemini', 'azure', 'elevenlabs']);

/** Characters a TTS engine reads out literally instead of ignoring. */
const MARKDOWN_NOISE_RE = /[*_`#]+/g;

/**
 * Everything spoken out loud passes through here on its way to a TTS engine.
 *
 * It is deliberately THIN. The two strings that carry numbers a patient must be
 * able to act on — the booking recap and the emergency script — are already
 * speech-shaped at the source (formatWhenSpoken in brain/tools.js,
 * speakableNumber in notifications/pipeline.js, both since V2), and re-parsing
 * them here would be a second, drifting implementation of the same rule. What
 * this DOES remove is markdown: models emit `**نعم**` and `- point` out of pure
 * habit, and Azure and ElevenLabs both read the asterisks aloud. Raw digits the
 * model invents mid-sentence are the PROMPT's responsibility (prompts.js orders
 * numbers spoken as words) — see the normalization note in ./elevenlabs.js.
 *
 * @param {string} text
 * @param {string} [lang] reserved: no rule differs by language today
 * @returns {string}
 */
export function normalizeSpoken(text, lang) {
  return String(text ?? '')
    .replace(MARKDOWN_NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The tenant's voice block, tolerant of a clinic object OR a tenant record. */
function voiceConfig(clinic) {
  if (!clinic || typeof clinic !== 'object') return {};
  const v = clinic.voice ?? clinic.config?.voice;
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * Build the mouth for ONE call.
 *
 * @param {object} p
 * @param {object} [p.config]     the runtime config (keys + the global default)
 * @param {object} [p.clinic]     the tenant (per-tenant provider + voice id)
 * @param {Function} [p.logger]
 * @param {Function} [p.fetchImpl] injected in tests; defaults to globalThis.fetch
 * @param {Function} [p.now]       ms clock, injected by the breaker tests
 * @returns {{mode:'native'|'tts', provider:string, voice:string|null,
 *   synthesize:Function|null, normalizeSpoken:Function, markDegraded:Function,
 *   describe:Function}}
 */
export function createTtsChain({ config = {}, clinic, logger, fetchImpl, now } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const clock = typeof now === 'function' ? now : () => Date.now();
  const tenantVoice = voiceConfig(clinic);

  const requested = String(tenantVoice.provider || config.voiceTtsProvider || 'gemini')
    .trim()
    .toLowerCase();
  let wanted = requested;
  if (!TTS_PROVIDERS.has(wanted)) {
    log(
      `[voice-brain] unknown TTS provider ${JSON.stringify(requested)} — expected one of ` +
        `${[...TTS_PROVIDERS].join(', ')}. Using the native Gemini voice.`
    );
    wanted = 'gemini';
  }

  let mode = 'native';
  let provider = 'gemini';
  let voice = null;
  let impl = null;
  let degraded = false;

  /** One line, once per call, naming exactly what is missing. */
  const stayNative = (name, why) => {
    log(`[voice-brain] TTS provider ${name} is configured but unusable (${why}) — using the native Gemini voice.`);
  };

  // THE BREAKER (see ./breaker.js). Consulted BEFORE anything is constructed,
  // because the whole value is in not opening a TEXT session at all: a vendor
  // outage would otherwise cost every single caller a greeting, a failed
  // synthesis and a hang-up, one at a time, for as long as it lasted.
  if (
    (wanted === 'azure' || wanted === 'elevenlabs') &&
    isTtsBreakerOpen(wanted, {
      threshold: Number(config.voiceTtsBreakerThreshold) || DEFAULT_TTS_BREAKER_THRESHOLD,
      cooldownMs: Number(config.voiceTtsBreakerCooldownMs) || DEFAULT_TTS_BREAKER_COOLDOWN_MS,
      at: clock(),
    })
  ) {
    log(
      `[voice-brain] TTS breaker OPEN for ${wanted} — this call takes the native Gemini voice. ` +
        `A clinic that answers in a plainer voice is working; a clinic that hangs up on every caller is not.`
    );
    wanted = 'gemini';
  }

  if (wanted === 'azure' || wanted === 'elevenlabs') {
    try {
      if (wanted === 'azure') {
        const key = String(config.azureSpeechKey || '');
        const region = String(config.azureSpeechRegion || '');
        if (!key || !region) {
          stayNative('azure', 'AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must both be set');
        } else {
          impl = createAzureTts({
            key,
            region,
            // `azureVoice` is the explicit field; `voiceId` is the generic
            // "whatever this provider calls a voice" one. Either is accepted so
            // a tenant that filled in one field is not silently ignored.
            voice: tenantVoice.azureVoice || tenantVoice.voiceId || '',
            fetchImpl,
            logger: log,
          });
        }
      } else {
        const apiKey = String(config.elevenlabsApiKey || '');
        const voiceId = String(tenantVoice.elevenVoiceId || tenantVoice.voiceId || '').trim();
        if (!apiKey) stayNative('elevenlabs', 'ELEVENLABS_API_KEY is not set');
        else if (!voiceId) stayNative('elevenlabs', 'this tenant has no voice.elevenVoiceId — a clone belongs to a consenting person');
        else impl = createElevenLabsTts({ apiKey, voiceId, fetchImpl, logger: log });
      }
    } catch (err) {
      // A provider that refuses to construct (bad region, malformed voice id)
      // is a settings problem, not an outage. Same treatment as a missing key.
      stayNative(wanted, err?.message || String(err));
      impl = null;
    }
  }

  if (impl) {
    mode = 'tts';
    provider = impl.provider;
    voice = impl.voice || null;
    log(`[voice-brain] voice: ${provider}${voice ? ` (${voice})` : ' (language default)'} — Live runs in TEXT mode`);
  }

  return {
    get mode() {
      return mode;
    },
    get provider() {
      return provider;
    },
    /** The tenant's explicit voice, or null when a language default applies. */
    get voice() {
      return voice;
    },

    /**
     * The per-call cache discriminator for the greeting tape (see
     * greetingCache.js). A Reem tape must never replay on a tenant that has
     * since switched to Hedi — or to the native Gemini voice. Empty string in
     * native mode, which keeps every pre-V5-T1 cache key byte-identical.
     */
    cacheKey() {
      return mode === 'tts' ? `${provider}:${voice || 'default'}` : '';
    },

    /**
     * PCM16 mono @24 kHz, streamed. Null in native mode — there is nothing to
     * synthesize, the Live session is already speaking, and a stub that threw
     * would be one more thing for a caller to hear.
     */
    synthesize: impl
      ? (text, opts) => impl.synthesize(text, opts)
      : null,

    normalizeSpoken,

    /** The provider failed on this call and will not be used again on it. */
    markDegraded() {
      degraded = true;
    },

    /** Rides out on outcome().voice — ops, analytics and the transcript row. */
    describe() {
      return { mode, provider, voice, degraded };
    },
  };
}

export default createTtsChain;
