// Fish Audio streaming TTS — the ZERO-BUDGET primary mouth (V7 doctrine).
//
// WHY IT IS PRIMARY, stated honestly: it is not the fastest. ElevenLabs Flash
// measured 174 ms TTFB against Fish's 572 ms (P0, 2026-08-01). ElevenLabs' free
// tier is 10 000 characters A MONTH — about 65 spoken replies, i.e. under ten
// real calls — and it forbids both commercial use and cloning. Fish's free
// model is fair-use unlimited, its Arabic clone path is verified working on the
// founder's key, and it answers at 8 kHz on request, which deletes the resample
// stage from a G.711 leg outright. The ~400 ms is bought back in the
// orchestrator (chunk at the first clause, filler armed at 700 ms), not from a
// vendor. See docs/VOICE-AGENT-SPEC.md §"P0 MEASURED RESULTS".
//
// VERIFIED CONTRACT (measured 2026-08-01, this exact shape returned audio):
//   POST https://api.fish.audio/v1/tts
//   Authorization: Bearer <FISH_AUDIO_API>
//   Content-Type: application/json
//   model: s2.1-pro-free          ← a HEADER, and the only model selector.
//   body: { text, format: 'pcm', sample_rate: 8000, latency: 'balanced',
//           reference_id?: '<pre-created voice model>' }
//   → chunked RAW PCM16LE mono at the requested sample_rate (headerless).
//
// FOUR THINGS THAT WERE PAID FOR IN MEASUREMENTS, NOT GUESSED:
//  1. `s2.1-pro-free` is the ONLY model a free key may use. `s2.1-pro`,
//     `s2-pro`, `s1` and `speech-1.6` all return 402 "Insufficient API credit".
//     The model rides in a HEADER; there is no body field for it.
//  2. `sample_rate: 8000` IS honoured. On a PCMA (G.711) leg those samples go
//     straight into alawEncode with no rate conversion at all — which is why
//     this provider declares `sampleRate` and the codec bridge takes a source
//     rate (see brain/codec.js encodeOut).
//  3. NEVER upload a reference per request. `references:[{audio,text}]` works
//     (msgpack only — the JSON form is rejected) but costs **+858 ms every
//     turn** because the 240 KB clip is re-uploaded. A pre-created voice model
//     addressed by `reference_id` is the same 572 ms as the stock voice. Clone
//     once at onboarding (scripts/fish-create-voice.js), store the id per
//     tenant, and pay nothing per turn. That is the ship rule.
//  4. A reference id goes into a JSON body, not a URL — but it is still
//     tenant-supplied text reaching a vendor, so it is whitelisted rather than
//     escaped, exactly like the ElevenLabs voice id.
import { streamTtsPcm, TtsError, TTS_TIMEOUT_MS } from './wire.js';

export const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';

/** The ONE model a free key may use. Everything else 402s (P0-measured). */
export const FISH_MODEL = 's2.1-pro-free';

/**
 * 8 kHz: G.711-ready, so a PCMA leg never resamples. It is the DEFAULT because
 * that is what the incumbent measured and shipped.
 *
 * IT IS THE WRONG ANSWER ON AN OPUS LEG, and the first live cascade call proved
 * it: synthesizing at 8 kHz onto a 48 kHz Opus wire throws away every frequency
 * above 4 kHz and then upsamples the corpse — the caller hears a landline
 * ("voice quality is low", founder, 2026-08-01). Opus legs therefore ask for
 * FISH_WIDEBAND_RATE, which is the brain's own rate and an exact 1:2 integer
 * upsample to 48 kHz. See createTtsChain({ wireCodec }).
 */
export const FISH_SAMPLE_RATE = 8000;

/** What an Opus leg asks for: no band loss, and an exact integer resample. */
export const FISH_WIDEBAND_RATE = 24000;

/**
 * The rates Fish accepts AND that brain/codec.js converts to a wire rate
 * exactly (48000 % r === 0 for Opus, r === 8000 for PCMA). A rate outside this
 * set would fall into the linear resampler on the RTP hot path, which is the
 * one place this product does not accept "probably fine".
 */
export const FISH_SAMPLE_RATES = Object.freeze([8000, 16000, 24000, 48000]);

/** 'balanced' | 'normal'. Balanced is what the P0 numbers were measured on. */
export const FISH_LATENCY_MODE = 'balanced';

/**
 * A reference id identifies a voice model on the founder's Fish account and is
 * per-tenant configuration. Whitelist it: there is no legitimate id that needs
 * anything outside this set, and a blacklist is how injection ships.
 * Exported so src/api/tenant.js can refuse a malformed one at SAVE time.
 */
export const FISH_REFERENCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {object} p
 * @param {string} p.apiKey         FISH_AUDIO_API (the founder's exact var name)
 * @param {string} [p.referenceId]  a PRE-CREATED voice model id. Optional: the
 *   stock Arabic voice is used without one, which is the zero-config path.
 * @param {string} [p.model]        override the model header (ops escape hatch)
 * @param {number} [p.sampleRate]   the rate to SYNTHESIZE at — 8000 for a G.711
 *   leg, 24000 for an Opus leg. Defaults to 8000, so every pre-V7-P2.1 caller
 *   behaves byte-identically.
 * @param {Function} [p.fetchImpl]
 * @param {Function} [p.logger]
 * @param {number} [p.timeoutMs]
 * @returns {{provider:string, voice:string|null, sampleRate:number, url:string,
 *   synthesize:Function}}
 */
export function createFishAudioTts({
  apiKey,
  referenceId,
  model = FISH_MODEL,
  sampleRate = FISH_SAMPLE_RATE,
  fetchImpl,
  logger,
  timeoutMs = TTS_TIMEOUT_MS,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const key = String(apiKey || '');
  const ref = String(referenceId || '').trim();
  const rate = Number(sampleRate);
  if (!FISH_SAMPLE_RATES.includes(rate)) {
    throw new TtsError(
      `fish sample rate ${JSON.stringify(sampleRate)} is not one of ${FISH_SAMPLE_RATES.join(', ')}`,
      { provider: 'fish', kind: 'config' }
    );
  }
  if (!key) {
    throw new TtsError('fish TTS needs FISH_AUDIO_API', { provider: 'fish', kind: 'config' });
  }
  if (ref && !FISH_REFERENCE_ID_RE.test(ref)) {
    throw new TtsError(`fish reference id ${JSON.stringify(ref)} is not a valid voice model id`, {
      provider: 'fish',
      kind: 'config',
    });
  }
  const modelHeader = String(model || FISH_MODEL).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(modelHeader)) {
    throw new TtsError(`fish model ${JSON.stringify(model)} is not a valid model id`, {
      provider: 'fish',
      kind: 'config',
    });
  }

  log(
    `[voice-brain] fish audio armed (${modelHeader}, pcm@${rate}` +
      `${ref ? `, voice model ${ref}` : ', stock voice'})`
  );

  return {
    provider: 'fish',
    /** The per-tenant clone, when there is one. Null ⇒ the stock Arabic voice. */
    voice: ref || null,
    /** Declared, not assumed: brain/codec.js converts from here to the wire. */
    sampleRate: rate,
    url: FISH_TTS_URL,

    /**
     * @param {string} text  already speech-normalized (see tts/index.js)
     * @param {object} [opts] { lang, signal } — `lang` is unused: the model is
     *   multilingual and the dialect comes from the CLONE, so a language hint
     *   would be the thing that made it sound wrong.
     * @yields {Int16Array} PCM16 mono @ the constructed `sampleRate`
     */
    async *synthesize(text, { signal } = {}) {
      const said = String(text || '').trim();
      if (!said) return;
      yield* streamTtsPcm({
        fetchImpl,
        url: FISH_TTS_URL,
        provider: 'fish',
        signal,
        timeoutMs,
        init: {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            // Not a typo and not a body field: the model is selected by this
            // header and by nothing else (P0-verified).
            model: modelHeader,
          },
          body: JSON.stringify({
            text: said,
            format: 'pcm',
            sample_rate: rate,
            latency: FISH_LATENCY_MODE,
            ...(ref ? { reference_id: ref } : {}),
          }),
        },
      });
    },
  };
}

export default createFishAudioTts;
