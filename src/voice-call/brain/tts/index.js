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
import { createFishAudioTts, FISH_SAMPLE_RATE, FISH_WIDEBAND_RATE } from './fishAudio.js';
import { BRAIN_OUT_RATE } from '../codec.js';
import { TtsError, isTtsError, TTS_TIMEOUT_MS } from './wire.js';
import {
  isTtsBreakerOpen,
  DEFAULT_TTS_BREAKER_THRESHOLD,
  DEFAULT_TTS_BREAKER_COOLDOWN_MS,
} from './breaker.js';
import { noteTtsChars, ttsCharsThisMonth } from './budget.js';

export { TtsError, isTtsError, TTS_TIMEOUT_MS };
export { createAzureTts } from './azure.js';
export { createElevenLabsTts } from './elevenlabs.js';
export { createFishAudioTts, FISH_SAMPLE_RATE, FISH_WIDEBAND_RATE } from './fishAudio.js';
export {
  noteTtsFailure,
  noteTtsOk,
  isTtsBreakerOpen,
  resetTtsBreakers,
  ttsBreakerStats,
  DEFAULT_TTS_BREAKER_THRESHOLD,
  DEFAULT_TTS_BREAKER_COOLDOWN_MS,
} from './breaker.js';
export { noteTtsChars, ttsCharsThisMonth, resetTtsBudget, ttsBudgetStats, monthKey } from './budget.js';

/**
 * ElevenLabs free tier is 10 000 chars/month (P0-measured). The FALLBACK stops
 * choosing it below that, so the last of the allowance belongs to a human's
 * decision rather than to an automatic downgrade.
 */
export const DEFAULT_EL_MONTHLY_SOFT_CAP = 8000;

/** Everything a tenant is allowed to name. Validated again in api/tenant.js. */
export const TTS_PROVIDERS = new Set(['gemini', 'azure', 'elevenlabs', 'fish']);

/**
 * THE ZERO-BUDGET FALLBACK ORDER (V7 doctrine, 2026-08-01). When the provider a
 * tenant asked for cannot be used on THIS call — no credential, a malformed
 * voice id, an open breaker — these are tried in order before the native voice.
 *
 * Fish first because its free tier is fair-use unlimited and its Arabic clone
 * path is verified; ElevenLabs second because 10 000 characters a MONTH is a
 * demo budget, not a receptionist (P0-measured from /v1/user/subscription).
 * Azure is deliberately NOT in this list: it is parked pending a signup, so it
 * is only ever used when a tenant explicitly names it.
 *
 * A fallback candidate never logs: only the provider the tenant actually ASKED
 * for earns a warning line, or every call on a native-voice tenant would print
 * two lines about vendors nobody chose.
 */
export const TTS_FALLBACK_ORDER = Object.freeze(['fish', 'elevenlabs']);

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
 * @param {boolean} [p.requireMouth] THE CALLER HAS NO NATIVE VOICE.
 *
 *   False (the default, and what brain/loop.js passes): resolving to `gemini` —
 *   whether because the tenant asked for it, because nothing is configured, or
 *   because a named provider was unusable — is TERMINAL. The incumbent Live
 *   loop's native audio is the thing that answers the phone when a vendor is
 *   down or unpaid, and a chain that quietly walked a no-config tenant onto a
 *   paid vendor would change what every existing call sounds like. Found in
 *   review: adding `fish` to the fallback order flipped the LIVE incumbent onto
 *   Fish for every tenant the moment FISH_AUDIO_API appeared in .env.
 *
 *   True (what brain-cascade/ passes): there IS no native voice — the cascade's
 *   brain is a text model, so a native result is a call it cannot take. Only
 *   then is the doctrine fallback order walked.
 * @param {'opus'|'pcma'} [p.wireCodec] THE NEGOTIATED LEG (V7-P2.1). Fish is
 *   asked to synthesize at the rate the wire can carry: 8 kHz for PCMA (no
 *   resampling at all) and 24 kHz for Opus (no band loss, exact 1:2 upsample).
 *   Absent ⇒ 8 kHz, which is what every pre-V7-P2.1 caller got.
 * @returns {{mode:'native'|'tts', provider:string, voice:string|null,
 *   sampleRate:number, synthesize:Function|null, meter:Function,
 *   normalizeSpoken:Function, markDegraded:Function, describe:Function}}
 */
export function createTtsChain({
  config = {},
  clinic,
  logger,
  fetchImpl,
  now,
  requireMouth = false,
  wireCodec = null,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const clock = typeof now === 'function' ? now : () => Date.now();
  const tenantVoice = voiceConfig(clinic);
  /**
   * 8 kHz is right for G.711 and WRONG for Opus — the founder's first live
   * cascade call was synthesized at telephone band and then upsampled onto a
   * 48 kHz wire. Only a leg we KNOW is Opus is widened; an unknown leg keeps
   * the incumbent's rate, because guessing wide on a G.711 call would add a
   * resample stage this provider was chosen to delete.
   */
  const fishRate = wireCodec === 'opus' ? FISH_WIDEBAND_RATE : FISH_SAMPLE_RATE;

  const requested = String(tenantVoice.provider || config.voiceTtsProvider || 'gemini')
    .trim()
    .toLowerCase();
  let wanted = config.voiceBenchmarkMode
    ? String(config.voiceBenchmarkTtsProvider || '').trim().toLowerCase()
    : requested;
  if (config.voiceBenchmarkMode && !wanted) {
    throw new TtsError('benchmark mode requires VOICE_BENCHMARK_TTS_PROVIDER', {
      provider: 'benchmark',
      kind: 'config',
    });
  }
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
  /** V7 metering: what this call actually cost the vendor. */
  let chars = 0;
  let requests = 0;

  /** One line, once per call, naming exactly what is missing. */
  const stayNative = (name, why) => {
    log(`[voice-brain] TTS provider ${name} is configured but unusable (${why}) — using the native Gemini voice.`);
  };

  const breakerOpts = {
    threshold: Number(config.voiceTtsBreakerThreshold) || DEFAULT_TTS_BREAKER_THRESHOLD,
    cooldownMs: Number(config.voiceTtsBreakerCooldownMs) || DEFAULT_TTS_BREAKER_COOLDOWN_MS,
  };

  /**
   * Try to build ONE provider. Returns the impl or null.
   * @param {string} name
   * @param {boolean} asked  true ⇒ the tenant named it, so a failure is worth a
   *   line. false ⇒ it is a silent fallback candidate.
   */
  function build(name, asked) {
    if (name === 'gemini') return null;
    // THE GENERIC `voiceId` BELONGS TO THE PROVIDER THAT WAS ASKED FOR, and to
    // nobody else. Found in review: a tenant on Azure with
    // `voiceId: 'ar-TN-ReemNeural'` whose Azure key was missing fell through to
    // Fish, which sent that Azure voice NAME as a Fish `reference_id` — a 4xx on
    // the first sentence of every call, i.e. tts_lost, i.e. a hung-up call.
    // A fallback candidate uses its OWN field or no voice at all.
    const generic = asked ? String(tenantVoice.voiceId || '').trim() : '';
    // THE BREAKER (see ./breaker.js). Consulted BEFORE anything is constructed,
    // because the whole value is in not opening a TEXT session at all: a vendor
    // outage would otherwise cost every single caller a greeting, a failed
    // synthesis and a hang-up, one at a time, for as long as it lasted.
    if (isTtsBreakerOpen(name, { ...breakerOpts, at: clock() })) {
      if (asked) {
        log(
          `[voice-brain] TTS breaker OPEN for ${name} — this call takes the next voice in the chain. ` +
            `A clinic that answers in a plainer voice is working; a clinic that hangs up on every caller is not.`
        );
      }
      return null;
    }
    try {
      if (name === 'azure') {
        const key = String(config.azureSpeechKey || '');
        const region = String(config.azureSpeechRegion || '');
        if (!key || !region) {
          if (asked) stayNative('azure', 'AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must both be set');
          return null;
        }
        return createAzureTts({
          key,
          region,
          // `azureVoice` is the explicit field; the generic `voiceId` is only
          // honoured when this is the provider the tenant actually chose.
          voice: tenantVoice.azureVoice || generic || '',
          fetchImpl,
          logger: log,
        });
      }
      if (name === 'elevenlabs') {
        const apiKey = String(config.elevenlabsApiKey || '');
        const voiceId = String(tenantVoice.elevenVoiceId || generic || '').trim();
        if (!apiKey) {
          if (asked) stayNative('elevenlabs', 'ELEVENLABS_API_KEY is not set');
          return null;
        }
        if (!voiceId) {
          if (asked) {
            stayNative(
              'elevenlabs',
              'this tenant has no voice.elevenVoiceId — a clone belongs to a consenting person'
            );
          }
          return null;
        }
        // THE MONTHLY WALL (./budget.js). 10 000 characters a month is about
        // sixty-five spoken replies; a Fish outage would otherwise drain the
        // whole allowance through the FALLBACK in one afternoon, and the
        // founder would find out during a demo. A tenant who chose ElevenLabs
        // explicitly is never blocked — they may be paying for it.
        if (!asked) {
          const softCap = Number(config.voiceElMonthlySoftCap) || DEFAULT_EL_MONTHLY_SOFT_CAP;
          const used = ttsCharsThisMonth('elevenlabs', clock());
          if (used >= softCap) {
            log(
              `[voice-brain] elevenlabs is past its monthly soft cap (${used}/${softCap} chars) — ` +
                `not spending the rest of the free tier on a fallback. A tenant who asks for it explicitly still gets it.`
            );
            return null;
          }
        }
        return createElevenLabsTts({ apiKey, voiceId, fetchImpl, logger: log });
      }
      if (name === 'fish') {
        const apiKey = String(config.fishAudioApi || '');
        if (!apiKey) {
          if (asked) stayNative('fish', 'FISH_AUDIO_API is not set');
          return null;
        }
        // A Fish "voice" is a PRE-CREATED voice model id (scripts/fish-create-voice.js).
        // Absent ⇒ the stock Arabic voice, which is a working phone line, not a
        // failure: never uploading a reference per request is the ship rule.
        return createFishAudioTts({
          apiKey,
          referenceId: tenantVoice.fishVoiceId || generic || '',
          sampleRate: fishRate,
          fetchImpl,
          logger: log,
        });
      }
    } catch (err) {
      // A provider that refuses to construct (bad region, malformed voice id)
      // is a settings problem, not an outage. Same treatment as a missing key.
      if (asked) stayNative(name, err?.message || String(err));
      return null;
    }
    return null;
  }

  // THE CANDIDATE WALK, and the one rule that keeps the incumbent safe:
  //   • `gemini` resolved ⇒ TERMINAL, unless the caller has no native voice.
  //     Nothing is tried, nothing is logged, the call takes the native voice.
  //   • anything else ⇒ that provider first, then the doctrine order.
  // Deduped so a tenant that asked for fish is not asked about it twice.
  const nativeIsAnswer = wanted === 'gemini' && !requireMouth;
  const candidates = config.voiceBenchmarkMode
    ? wanted === 'gemini'
      ? []
      : [wanted]
    : nativeIsAnswer
    ? []
    : wanted === 'gemini'
      ? [...TTS_FALLBACK_ORDER]
      : [wanted, ...TTS_FALLBACK_ORDER.filter((n) => n !== wanted)];
  for (const name of candidates) {
    impl = build(name, name === wanted);
    if (impl) break;
  }

  if (config.voiceBenchmarkMode && wanted !== 'gemini' && !impl) {
    throw new TtsError(`benchmark TTS ${wanted} is pinned but unavailable; fallback is disabled`, {
      provider: wanted,
      kind: 'config',
    });
  }

  if (impl) {
    mode = 'tts';
    provider = impl.provider;
    voice = impl.voice || null;
    if (provider !== wanted) {
      log(`[voice-brain] TTS fell back from ${wanted} to ${provider} for this call`);
    }
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
     * The rate the fitted mouth actually produces. 24 kHz for Gemini native,
     * Azure and ElevenLabs; for Fish Audio it is whatever the WIRE wants —
     * 8 kHz on a PCMA leg (G.711-ready, no resample at all) and 24 kHz on an
     * Opus leg. Consumers pass this to codec.encodeOut — playing 8 kHz samples
     * as 24 kHz is a third-speed voice.
     */
    get sampleRate() {
      return impl && Number(impl.sampleRate) > 0 ? Number(impl.sampleRate) : BRAIN_OUT_RATE;
    },

    /**
     * PCM16 mono at `sampleRate`, streamed. Null in native mode — there is
     * nothing to synthesize, the Live session is already speaking, and a stub
     * that threw would be one more thing for a caller to hear.
     */
    synthesize: impl
      ? (text, opts) => {
          // METERING (V7 doctrine §"Cost surfacing"): characters are what every
          // TTS vendor bills, so they are counted from day one — pass-through
          // billing at pilot signing is then one config away, not a migration.
          // The same count feeds the process-level monthly ledger, which is
          // what stops a fallback from eating a free tier (./budget.js).
          const n = String(text || '').length;
          chars += n;
          requests += 1;
          noteTtsChars(provider, n, clock());
          return impl.synthesize(text, opts);
        }
      : null,

    /** { chars, requests } spoken through this chain on this call. */
    meter() {
      return { chars, requests };
    },

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
