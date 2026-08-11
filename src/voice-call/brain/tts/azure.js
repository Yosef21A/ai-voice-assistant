// Azure Neural TTS — the cheap human mouth (V5-T1, ~$0.016/min).
//
// WHY AZURE IS THE FIRST RUNG. It is the only major vendor that ships NATIVE
// TUNISIAN AND LIBYAN Arabic neural voices. Every other provider offers "Arabic"
// meaning Modern Standard or Gulf, and a Sousse patient hears MSA from a clinic
// receptionist as instantly wrong — more wrong, in practice, than a slightly
// synthetic ar-TN voice. Dialect beats fidelity at this rung; T2 (ElevenLabs
// clone) buys the fidelity back.
//
// VERIFIED CONTRACT (2026-07):
//   POST https://<region>.tts.speech.microsoft.com/cognitiveservices/v1
//   Ocp-Apim-Subscription-Key: <key>
//   Content-Type: application/ssml+xml
//   X-Microsoft-OutputFormat: raw-24khz-16bit-mono-pcm
//   body: <speak version='1.0' xml:lang='…'><voice name='…'>text</voice></speak>
//   → chunked body of RAW PCM16LE mono @24 kHz — i.e. exactly what Gemini Live
//     hands us natively, so codec.encodeOut() needs no change whatsoever.
//
// TWO INJECTION SURFACES, BOTH CLOSED HERE, BOTH FOUND BY ASKING "who controls
// this string?":
//   • The TEXT is model output. It goes through escapeXml(), so a model that
//     emits `</voice><voice name='en-US-…'>` cannot re-open the voice element
//     and switch languages mid-sentence.
//   • The VOICE NAME and the REGION are TENANT settings — a dashboard field.
//     They are interpolated into an XML attribute and into a hostname
//     respectively, so both are whitelist-validated (letters, digits, hyphens)
//     at construction. A voice name that fails the whitelist is refused rather
//     than escaped: an escaped-but-wrong voice name is a call in the wrong
//     language, and falling back to the tenant's language default is the honest
//     answer. A region that fails it would be an SSRF vector, so THAT one
//     refuses to construct at all and the chain degrades to the native voice.
import { streamTtsPcm, TtsError, TTS_TIMEOUT_MS } from './wire.js';

/** The default host template. The region is validated before it lands here. */
const HOST = (region) => `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

/** Raw PCM out — no container, no header, nothing to strip. */
export const AZURE_OUTPUT_FORMAT = 'raw-24khz-16bit-mono-pcm';

/**
 * The voices this product actually ships with (verified against the Azure
 * neural voice list, 2026-07). Female is the default in all three languages:
 * a clinic reception desk in Tunisia is overwhelmingly a woman's voice, and the
 * point of this tier is that nothing sounds off.
 */
export const AZURE_VOICES = {
  ar: { female: 'ar-TN-ReemNeural', male: 'ar-TN-HediNeural' },
  'ar-LY': { female: 'ar-LY-ImanNeural', male: 'ar-LY-OmarNeural' },
  fr: { female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' },
  en: { female: 'en-US-JennyNeural', male: 'en-US-GuyNeural' },
};

/** lang → the voice used when the tenant named none. */
export const AZURE_DEFAULT_VOICES = {
  ar: AZURE_VOICES.ar.female,
  fr: AZURE_VOICES.fr.female,
  en: AZURE_VOICES.en.female,
};

/**
 * A voice name is `xx-YY-NameNeural`; a region is `westeurope`. Both are ASCII.
 * AZURE_VOICE_RE is EXPORTED and re-used by src/api/tenant.js so a malformed
 * voice name is a 400 at save time, in front of the person who typed it —
 * rather than a silent downgrade to the language default, discovered weeks
 * later on a live call by a clinic wondering why they paid for a voice.
 */
export const AZURE_VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z0-9]{2,8}-[A-Za-z0-9]+$/;
const VOICE_RE = AZURE_VOICE_RE;
const REGION_RE = /^[A-Za-z0-9-]{2,40}$/;

/** The five XML entities. `'` is escaped too — our attributes use it. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The voice name IS the language: `ar-TN-ReemNeural` → `ar-TN`. Deriving it
 * rather than carrying a second setting removes the one inconsistency that
 * matters here — an `xml:lang` that disagrees with the voice makes Azure
 * mispronounce, and nobody would ever look at the SSML to find out why.
 */
export function xmlLangOf(voice) {
  const parts = String(voice || '').split('-');
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'ar-TN';
}

/**
 * @param {string} text   already normalized for speech (see tts/index.js)
 * @param {string} voice  a whitelist-validated voice name
 */
export function buildSsml(text, voice) {
  return (
    `<speak version='1.0' xml:lang='${escapeXml(xmlLangOf(voice))}'>` +
    `<voice name='${escapeXml(voice)}'>${escapeXml(text)}</voice>` +
    `</speak>`
  );
}

/**
 * @param {object} p
 * @param {string} p.key      AZURE_SPEECH_KEY
 * @param {string} p.region   AZURE_SPEECH_REGION ('westeurope')
 * @param {string} [p.voice]  per-tenant override; else the language default
 * @param {Function} [p.fetchImpl]
 * @param {Function} [p.logger]
 * @param {number} [p.timeoutMs]
 * @returns {{provider:string, voice:string|null, resolveVoice:Function, synthesize:Function}}
 */
export function createAzureTts({ key, region, voice, fetchImpl, logger, timeoutMs = TTS_TIMEOUT_MS } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const apiKey = String(key || '');
  const regionName = String(region || '').trim();
  if (!apiKey) throw new TtsError('azure TTS needs AZURE_SPEECH_KEY', { provider: 'azure', kind: 'config' });
  if (!REGION_RE.test(regionName)) {
    // Refuse rather than sanitize: this string becomes a hostname the server
    // connects to, and "clean it up and hope" is how SSRF ships.
    throw new TtsError(`azure TTS region ${JSON.stringify(regionName)} is not a valid region name`, {
      provider: 'azure',
      kind: 'config',
    });
  }

  const override = String(voice || '').trim();
  let configured = null;
  if (override) {
    if (VOICE_RE.test(override)) configured = override;
    else {
      log(
        `[voice-brain] ignoring azure voice ${JSON.stringify(override)} — expected a name like ` +
          `ar-TN-ReemNeural. Falling back to the language default.`
      );
    }
  }

  const url = HOST(regionName);

  /** The voice this call will actually use, for a given language. */
  function resolveVoice(lang) {
    if (configured) return configured;
    return AZURE_DEFAULT_VOICES[lang] || AZURE_DEFAULT_VOICES.ar;
  }

  return {
    provider: 'azure',
    /** The tenant's override, or null when the language default is in play. */
    voice: configured,
    url,
    resolveVoice,

    /**
     * @param {string} text
     * @param {object} [opts] { lang, signal }
     * @yields {Int16Array} PCM16 mono @24 kHz
     */
    async *synthesize(text, { lang = 'ar', signal } = {}) {
      const said = String(text || '').trim();
      if (!said) return;
      const chosen = resolveVoice(lang);
      yield* streamTtsPcm({
        fetchImpl,
        url,
        provider: 'azure',
        signal,
        timeoutMs,
        init: {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
            'User-Agent': 'omen-clinic-agent',
          },
          body: buildSsml(said, chosen),
        },
      });
    },
  };
}

export default createAzureTts;
