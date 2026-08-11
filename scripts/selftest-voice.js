// THE CALLER'S VOICE — Fish-synthesized derja clips for scripts/call-selftest.js.
//
// The A/B harness (scripts/cascade-ab.js) sends a 440 Hz tone, which is why it
// can only ever measure PLUMBING: a sine wave produces no words, so the STT
// never fires, the LLM never runs and the founder's actual question — "does the
// agent hold a conversation?" — stays unanswered. This module is the missing
// half: the same in-process werift caller, but SPEAKING.
//
// THREE RULES, each one bought with a measurement:
//
//  1. SYNTHESIZE ONCE, EVER. Every clip is cached on disk under
//     data/runtime/selftest-voice/ keyed by sha256(text|rate|model|voice). A
//     rehearsal run must not spend the founder's Fish quota re-saying «باهي»,
//     and a cached run makes the timing numbers comparable between rounds
//     because the caller is byte-identical.
//  2. 16 kHz, NOT 8. 16000 is on fishAudio.js's FISH_SAMPLE_RATES whitelist, so
//     it is requested directly and never resampled here. 16 kHz → 48 kHz Opus
//     is an exact 1:3 integer upsample in brain/g711.js, so the caller's voice
//     reaches the agent's ears without a linear resampler anywhere in the path.
//     A telephone-band caller would make the STT look worse than it is.
//  3. THE PROVIDER MODULE, NOT A HAND-ROLLED FETCH. createFishAudioTts() carries
//     the model header, the whitelist, the reference-id validation and the whole
//     wire discipline (odd-byte carry, stall timer, observed cancels). A second
//     copy of that in a script is how a self-test starts lying.
//
// This file NEVER decides anything about the test. It turns text into PCM.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createFishAudioTts, FISH_MODEL, FISH_SAMPLE_RATES } from '../src/voice-call/brain/tts/fishAudio.js';
import { downsample } from '../src/voice-call/brain/g711.js';

/**
 * What the caller says. 16 kHz if Fish will take it (it will — the whitelist is
 * asserted at load), else 24 kHz downsampled here so the rest of the harness
 * never has to care.
 */
export const CALLER_RATE = FISH_SAMPLE_RATES.includes(16000) ? 16000 : 24000;

/** The rate we ASK Fish for. Equal to CALLER_RATE unless the whitelist moved. */
const SYNTH_RATE = FISH_SAMPLE_RATES.includes(CALLER_RATE) ? CALLER_RATE : 24000;

/**
 * THE SCRIPT. Tunisian derja, exactly the sentences the founder's Monday demo
 * flow uses, plus the three that exist only to attack the agent:
 *
 *   • `ack`        — «باهي» played INTO the agent's sentence. It must not stop it.
 *   • `correction` — a real interruption. It MUST stop it.
 *   • `phone1`/`phone2` — one phone number in TWO clips with a pause in the
 *     middle, which is how a human reads a number off a card and the exact
 *     shape V8-D2 §1's PATIENT endpointer exists for.
 */
// TWO LINES DEVIATE FROM THE ORIGINAL BRIEF, and both deviations are the
// harness being wrong rather than the product:
//
//  • `specialty` was a bare «قلب». Synthesized alone it is one syllable, and
//    liveEars returned «كلب» — DOG — twice in a row, so the agent (correctly,
//    and rather well) answered that it is a clinic for humans. That is a
//    qaf/kaf ASR ambiguity no code change fixes, and a bare noun is not what
//    the rehearsed 90-second demo flow says anyway. It now carries a sentence
//    around it, which is both realistic and unambiguous.
//  • `day` was «الخميس العشية» (Thursday AFTERNOON). The agent looked the slots
//    up, found none, and counter-offered Thursday MORNING — correct behaviour,
//    and a question a fixed script has no answer to, so every later line landed
//    one beat behind. The rehearsed demo flow in docs/VOICE-AGENT-SPEC.md §V8
//    says "book cardiology Thursday morning"; the clip now says that.
//  • `phone2` was «أربعة تسعة ستة». With `phone1` that is SEVEN digits, and
//    engine/slots.js extractContact() requires eight — so `stage_booking`
//    refused with `missing_contact` and the booking could never land. The
//    product was right and the script was wrong: one digit was added, and the
//    two-clip mid-number pause the brief asked for is unchanged.
export const CALLER_LINES = Object.freeze({
  book: 'أهلا، نحب نحجز موعد',
  specialty: 'نحب نشوف طبيب القلب',
  day: 'نهار الخميس الصباح',
  name: 'محمد الهادي',
  phone1: 'واحد وعشرين تسعة وعشرين',
  phone2: 'أربعة تسعة ستة سبعة',
  ack: 'باهي',
  correction: 'لا سامحني، نحب نبدل النهار',
  confirm: 'نعم صحيح',
  bye: 'بسلامة',
});

export const CLIP_KEYS = Object.freeze(Object.keys(CALLER_LINES));

/** Stable cache identity: change any input and the clip is re-synthesized. */
export function clipHash(text, { rate = SYNTH_RATE, model = FISH_MODEL, voice = '' } = {}) {
  return createHash('sha256').update(`${text}|${rate}|${model}|${voice}`).digest('hex').slice(0, 16);
}

const indexFile = (dir) => path.join(dir, 'index.json');

function readIndex(dir) {
  try {
    const f = indexFile(dir);
    if (!existsSync(f)) return {};
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // a half-written index is a cold cache, never a crash
  }
}

function writeIndex(dir, index) {
  writeFileSync(indexFile(dir), JSON.stringify(index, null, 2));
}

/** Raw PCM16LE on disk ⇄ Int16Array in memory. No header, no container. */
function readPcm(file) {
  const buf = readFileSync(file);
  const samples = buf.length >> 1;
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function writePcm(file, int16) {
  const buf = Buffer.allocUnsafe(int16.length * 2);
  for (let i = 0; i < int16.length; i += 1) buf.writeInt16LE(int16[i], i * 2);
  writeFileSync(file, buf);
}

function concatInt16(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * ONE clip, from the vendor. Returns PCM16 mono at CALLER_RATE.
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.text
 * @param {string} [p.voice] a pre-created Fish voice model id, if the founder
 *   ever wants the synthetic caller to sound like a specific person.
 * @returns {Promise<Int16Array>}
 */
async function synthesizeOnce({ apiKey, text, voice = '' }) {
  const tts = createFishAudioTts({ apiKey, referenceId: voice || undefined, sampleRate: SYNTH_RATE, logger: () => {} });
  const chunks = [];
  for await (const pcm of tts.synthesize(text)) chunks.push(pcm);
  const raw = concatInt16(chunks);
  if (!raw.length) throw new Error('fish returned no audio');
  return SYNTH_RATE === CALLER_RATE ? raw : downsample(raw, SYNTH_RATE, CALLER_RATE);
}

/**
 * Make sure every requested clip exists on disk, synthesizing only what is
 * missing. ONE retry per clip: a self-test that hammers a free tier to prove a
 * point has become the problem it was written to find.
 *
 * @param {object} p
 * @param {string} p.apiKey       FISH_AUDIO_API
 * @param {string} p.dir          data/runtime/selftest-voice
 * @param {string[]} [p.keys]     which lines (default: all)
 * @param {boolean} [p.offline]   --skip-synthesis: cache only, never the network
 * @param {Function} [p.log]
 * @returns {Promise<{clips:Map<string,Int16Array>, rows:object[], synthesized:number,
 *   cached:number, bytes:number, missing:string[]}>}
 */
export async function ensureClips({ apiKey, dir, keys = CLIP_KEYS, offline = false, voice = '', log = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const index = readIndex(dir);
  const clips = new Map();
  const rows = [];
  const missing = [];
  let synthesized = 0;
  let cached = 0;
  let bytes = 0;

  for (const key of keys) {
    const text = CALLER_LINES[key];
    if (!text) throw new Error(`unknown caller line ${JSON.stringify(key)}`);
    const hash = clipHash(text, { voice });
    const file = path.join(dir, `${key}-${hash}.pcm`);
    const entry = index[key];
    const fresh = entry && entry.hash === hash && existsSync(file);

    if (fresh) {
      const pcm = readPcm(file);
      clips.set(key, pcm);
      cached += 1;
      bytes += pcm.length * 2;
      rows.push({ key, text, hash, file, samples: pcm.length, ms: Math.round((pcm.length / CALLER_RATE) * 1000), source: 'cache' });
      continue;
    }

    if (offline) {
      missing.push(key);
      continue;
    }
    if (!apiKey) throw new Error('FISH_AUDIO_API is not set — the caller has no voice');

    let pcm = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !pcm; attempt += 1) {
      try {
        pcm = await synthesizeOnce({ apiKey, text, voice });
      } catch (err) {
        lastErr = err;
        log(`[selftest-voice] ${key}: attempt ${attempt + 1} failed — ${err?.message || err}`);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (!pcm) throw new Error(`could not synthesize ${key} («${text}»): ${lastErr?.message || lastErr}`);

    writePcm(file, pcm);
    index[key] = { hash, file: path.basename(file), text, rate: CALLER_RATE, samples: pcm.length };
    writeIndex(dir, index);
    clips.set(key, pcm);
    synthesized += 1;
    bytes += pcm.length * 2;
    rows.push({ key, text, hash, file, samples: pcm.length, ms: Math.round((pcm.length / CALLER_RATE) * 1000), source: 'fish' });
  }

  return { clips, rows, synthesized, cached, bytes, missing };
}

export default ensureClips;
