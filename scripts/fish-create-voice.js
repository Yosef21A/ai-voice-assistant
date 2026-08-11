// Create a Fish Audio VOICE MODEL from a consented recording — run ONCE per
// tenant voice, by a human, on purpose.
//
//   node scripts/fish-create-voice.js <audio-file> "<exact transcript>" [name]
//
// It prints a `reference_id`. Put that id in the tenant's settings
// (`voice: { provider: 'fish', fishVoiceId: '<id>' }`) and every call from then
// on uses the cloned voice at the SAME latency as the stock one.
//
// WHY THIS SCRIPT EXISTS AT ALL — the numbers are the whole argument (P0,
// 2026-08-01, 8 runs each):
//   • reference uploaded per REQUEST : 1430 ms median TTFB  (+858 ms every turn,
//     because the 240 KB clip is re-uploaded on every single sentence)
//   • pre-created voice model        :  572 ms median TTFB  — identical to stock
// So the reference is uploaded exactly once, here, and never again. Doing it
// per request is the one shape this product must never ship.
//
// WHY MSGPACK, AND WHY IT IS INLINE. Fish's model endpoint takes multipart, but
// the reference payload for the TTS endpoint is msgpack-only: the identical
// body as JSON with base64 audio comes back 400 "Reference Audio is not valid",
// and as msgpack with RAW BYTES it returns 200. Rather than take a dependency
// on a msgpack library for ~35 lines of encoder — this repo's runtime deps are
// `express` and `pg`, and that is a rule worth keeping — the encoder is here,
// covering exactly the shapes this body needs (map, str, bin, int, bool, nil).
//
// CONSENT IS NOT A FORMALITY. A cloned voice belongs to the person who
// recorded it. Do not run this on a sample you were not given for this purpose,
// and store the written consent with the tenant's contract. The same rule the
// ElevenLabs provider states in code: there is no default voice id, ever.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';

const API = 'https://api.fish.audio/v1/model';

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
Usage:
  node scripts/fish-create-voice.js <audio-file> "<exact transcript>" [voice name]

  <audio-file>   a 15-60 s CLEAN recording of ONE consented speaker (wav/mp3/m4a)
  <transcript>   what they actually say, word for word, in Arabic script
  [voice name]   optional label on the Fish account (default: omen-<file name>)

Requires FISH_AUDIO_API in .env.
`);
  process.exit(1);
}

// ── the inline msgpack encoder ──────────────────────────────────────────────
// Only the types this body contains. Anything else throws rather than encoding
// something the server would reject in a way nobody could diagnose.

function u8(...bytes) {
  return Buffer.from(bytes);
}

function encodeLength(prefixes, len) {
  // prefixes: [fixMask, fixMax, p8, p16, p32] — any may be null.
  const [fixMask, fixMax, p8, p16, p32] = prefixes;
  if (fixMask != null && len <= fixMax) return u8(fixMask | len);
  if (p8 != null && len < 0x100) return u8(p8, len);
  if (p16 != null && len < 0x10000) {
    const b = Buffer.allocUnsafe(3);
    b[0] = p16;
    b.writeUInt16BE(len, 1);
    return b;
  }
  const b = Buffer.allocUnsafe(5);
  b[0] = p32;
  b.writeUInt32BE(len, 1);
  return b;
}

export function msgpackEncode(value) {
  if (value === null || value === undefined) return u8(0xc0);
  if (typeof value === 'boolean') return u8(value ? 0xc3 : 0xc2);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      const b = Buffer.allocUnsafe(9);
      b[0] = 0xcb;
      b.writeDoubleBE(value, 1);
      return b;
    }
    if (value >= 0 && value < 0x80) return u8(value); // positive fixint
    if (value >= -32 && value < 0) return u8(0xe0 | (value + 32)); // negative fixint
    const b = Buffer.allocUnsafe(5);
    b[0] = 0xce; // uint32 covers every number this body uses
    b.writeUInt32BE(value >>> 0, 1);
    return b;
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([encodeLength([0xa0, 0x1f, 0xd9, 0xda, 0xdb], bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([encodeLength([null, 0, 0xc4, 0xc5, 0xc6], bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    const parts = value.map(msgpackEncode);
    return Buffer.concat([encodeLength([0x90, 0x0f, null, 0xdc, 0xdd], value.length), ...parts]);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    const parts = [];
    for (const [k, v] of entries) {
      parts.push(msgpackEncode(k), msgpackEncode(v));
    }
    return Buffer.concat([encodeLength([0x80, 0x0f, null, 0xde, 0xdf], entries.length), ...parts]);
  }
  throw new TypeError(`msgpack: unsupported value type ${typeof value}`);
}

// ── the call ────────────────────────────────────────────────────────────────

async function main() {
  // Read INSIDE main, never at import: this file is importable (the msgpack
  // encoder is unit-tested) and a test must never load .env or exit the
  // process because an argument is missing.
  const KEY = getConfig().fishAudioApi;
  const [, , filePath, transcript, nameArg] = process.argv;
  if (!KEY) usage('FISH_AUDIO_API is not set in .env — nothing to authenticate with.');
  if (!filePath) usage('No audio file given.');
  if (!transcript || !String(transcript).trim()) {
    usage('No transcript given. Fish needs the exact words for the reference to be usable.');
  }

  let audio;
  try {
    audio = readFileSync(filePath);
  } catch (err) {
    usage(`Could not read ${filePath}: ${err.message}`);
    return;
  }
  const title = nameArg || `omen-${path.basename(filePath).replace(/\.[^.]+$/, '')}`;
  const seconds = Math.round(audio.length / 32000); // rough, at 16 kHz 16-bit
  console.log(
    `Creating Fish voice model "${title}" from ${filePath} (${(audio.length / 1024).toFixed(0)} KB, ~${seconds}s).`
  );
  console.log('Confirm you have this speaker\'s written consent before you ship this voice.\n');

  const body = msgpackEncode({
    title,
    type: 'tts',
    train_mode: 'fast',
    // The reference: RAW BYTES plus the exact words. Base64 in JSON is what
    // fails; this is what works.
    voices: [audio],
    texts: [String(transcript)],
    enhance_audio_quality: true,
  });

  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/msgpack',
      },
      body,
    });
  } catch (err) {
    console.error(`\nRequest failed: ${err.message}`);
    process.exit(2);
    return;
  }

  const text = await res.text();
  console.log(`HTTP ${res.status}\n${text.slice(0, 2000)}`);
  if (res.status < 200 || res.status >= 300) {
    console.error('\nModel creation failed. 402 means the free wallet cannot cover this request;');
    console.error('only `s2.1-pro-free` synthesis is free on this key.');
    process.exit(3);
    return;
  }
  let id = null;
  try {
    id = JSON.parse(text)?._id || JSON.parse(text)?.id || null;
  } catch {
    /* the raw body is printed above either way */
  }
  if (id) {
    console.log(`\nreference_id: ${id}`);
    console.log('Put it on the tenant:  PUT /api/tenant  { "voice": { "provider": "fish", "fishVoiceId": "' + id + '" } }');
  } else {
    console.log('\nCould not find an id in the response — copy it from the body above.');
  }
}

// Importable for a unit test of the encoder; only runs when invoked directly.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('fish-create-voice.js');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exit(4);
  });
}
