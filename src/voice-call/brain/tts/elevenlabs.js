// ElevenLabs streaming TTS — the illusion tier (V5-T2's engine, wired at T1).
//
// This is the provider that gets used with a CONSENTED cloned voice of a native
// Tunisian speaker. There is no sane default voice id and there never will be:
// a clone belongs to a person who signed something, so a tenant that has not
// chosen one does not get this provider at all (the chain says so once, in a
// warning, and keeps the native Gemini voice).
//
// VERIFIED CONTRACT (2026-07):
//   POST https://api.elevenlabs.io/v1/text-to-speech/<voiceId>/stream
//        ?output_format=pcm_24000&optimize_streaming_latency=3
//   xi-api-key: <key>
//   Content-Type: application/json
//   body: { "text": "…", "model_id": "eleven_flash_v2_5" }
//   → chunked RAW PCM16LE mono @24 kHz (pcm_24000 is headerless), which is the
//     same shape Gemini Live and Azure produce, so nothing downstream changes.
//
// `optimize_streaming_latency=3` is the aggressive setting. On a phone call the
// tradeoff is not close: a marginally flatter prosody nobody can name beats
// several hundred extra milliseconds of dead air, which every caller can.
//
// THE ONE TRAP WORTH THE COMMENT — TEXT NORMALIZATION IS OFF. On
// eleven_flash_v2_5, automatic text normalization is an enterprise-only
// feature. Non-enterprise keys get the raw string read literally, so "14/08" is
// read as characters and "+216 29 496 305" is read as a mess. Everything this
// product speaks out loud is therefore ALREADY normalized before it arrives:
// the recap goes through formatWhenSpoken() (tools.js) and the emergency script
// through speakableNumber() (notifications/pipeline.js), both since V2. What
// remains — digits the MODEL invents mid-sentence — is handled by the voice
// system prompt, which orders numbers spoken as words. That is stated plainly
// because it is the one property of this file that lives outside this file.
import { streamTtsPcm, TtsError, TTS_TIMEOUT_MS } from './wire.js';

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

/** Flash: the low-latency multilingual model. Turbo/v3 are slower per chunk. */
export const ELEVEN_MODEL_ID = 'eleven_flash_v2_5';
/** Headerless PCM at the brain's own rate — no resample, no container. */
export const ELEVEN_OUTPUT_FORMAT = 'pcm_24000';
/** 0–4; 3 trades a little prosody for a lot of first-byte latency. */
export const ELEVEN_LATENCY_MODE = 3;

/**
 * A voice id goes into a URL PATH. Whitelist it rather than escape it: an id
 * carrying `../` or a query character is a request aimed somewhere we did not
 * intend, and there is no legitimate voice id that needs those characters.
 *
 * EXPORTED and re-used by src/api/tenant.js so the rejection happens at save
 * time, in front of the person who typed it, instead of as a silent fallback to
 * the native voice discovered on a live call.
 */
export const ELEVEN_VOICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VOICE_ID_RE = ELEVEN_VOICE_ID_RE;

/**
 * @param {string} voiceId  a validated ElevenLabs voice id
 * @returns {string} the exact streaming URL
 */
export function buildStreamUrl(voiceId) {
  return (
    `${API_BASE}/${voiceId}/stream` +
    `?output_format=${ELEVEN_OUTPUT_FORMAT}&optimize_streaming_latency=${ELEVEN_LATENCY_MODE}`
  );
}

/**
 * @param {object} p
 * @param {string} p.apiKey    ELEVENLABS_API_KEY
 * @param {string} p.voiceId   REQUIRED — per-tenant, no default exists
 * @param {Function} [p.fetchImpl]
 * @param {Function} [p.logger]
 * @param {number} [p.timeoutMs]
 * @returns {{provider:string, voice:string, url:string, synthesize:Function}}
 */
export function createElevenLabsTts({ apiKey, voiceId, fetchImpl, logger, timeoutMs = TTS_TIMEOUT_MS } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const key = String(apiKey || '');
  const id = String(voiceId || '').trim();
  if (!key) {
    throw new TtsError('elevenlabs TTS needs ELEVENLABS_API_KEY', { provider: 'elevenlabs', kind: 'config' });
  }
  if (!id) {
    throw new TtsError('elevenlabs TTS needs a per-tenant voice.elevenVoiceId — there is no default clone', {
      provider: 'elevenlabs',
      kind: 'config',
    });
  }
  if (!VOICE_ID_RE.test(id)) {
    throw new TtsError(`elevenlabs voice id ${JSON.stringify(id)} is not a valid voice id`, {
      provider: 'elevenlabs',
      kind: 'config',
    });
  }

  const url = buildStreamUrl(id);
  log(`[voice-brain] elevenlabs voice ${id} armed (${ELEVEN_MODEL_ID}, ${ELEVEN_OUTPUT_FORMAT})`);

  return {
    provider: 'elevenlabs',
    voice: id,
    url,

    /**
     * @param {string} text  already speech-normalized (see the header note)
     * @param {object} [opts] { lang, signal } — lang is unused: the model is
     *   multilingual and the CLONE carries the accent, so passing a language
     *   hint would be the thing that made it sound wrong.
     * @yields {Int16Array} PCM16 mono @24 kHz
     */
    async *synthesize(text, { signal } = {}) {
      const said = String(text || '').trim();
      if (!said) return;
      yield* streamTtsPcm({
        fetchImpl,
        url,
        provider: 'elevenlabs',
        signal,
        timeoutMs,
        init: {
          method: 'POST',
          headers: {
            'xi-api-key': key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: said, model_id: ELEVEN_MODEL_ID }),
        },
      });
    },
  };
}

export default createElevenLabsTts;
