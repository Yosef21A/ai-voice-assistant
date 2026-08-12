import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcousticClock, frameRms } from '../src/voice-call/acoustic.js';
import {
  bestWer,
  decodeWavPcm16,
  encodeWavPcm16,
  evaluateAcceptance,
  inspectWav,
  normalizeTranscript,
  scoreBenchmark,
  validateSuite,
  wordErrorRate,
} from '../src/voice-call/benchmark.js';
import { languagePolicyBlock } from '../src/voice-call/brain/prompts.js';
import { availableStt } from '../src/voice-call/brain-cascade/stt/index.js';
import { availableLlm } from '../src/voice-call/brain-cascade/llm/index.js';
import { createTtsChain } from '../src/voice-call/brain/tts/index.js';
import { resolveVoiceBrainMode } from '../src/voice-call/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = path.join(ROOT, 'benchmark', 'tunisian-voice');
const fixture = (name) => JSON.parse(readFileSync(path.join(SUITE, name), 'utf8'));

test('benchmark suite is internally linked and covers every required category', () => {
  const result = validateSuite({
    corpus: fixture('corpus.json'),
    scenarios: fixture('scenarios.json'),
    clinic: fixture('clinic.json'),
    acceptance: fixture('acceptance.json'),
    protocol: fixture('protocol.json'),
  });
  assert.deepEqual(result, { ok: true, errors: [], cases: 28, scenarios: 12 });
});

test('Tunisian transcript normalization is deterministic and accepted variants use minimum WER', () => {
  assert.equal(normalizeTranscript('إي، نأكّد الموعد!'), 'اي ناكد الموعد');
  assert.equal(wordErrorRate('نحب موعد نهار الاثنين', 'نحب موعد الاثنين'), 0.25);
  assert.equal(bestWer(['اسمي آية بن يوسف', 'اسمي اية بن يوسف'], 'اسمي آية بن يوسف'), 0);
});

test('acoustic clock starts on voiced PCM and reports the final voiced frame independently of STT EOT', () => {
  let at = 1000;
  const clock = createAcousticClock({ rmsThreshold: 1000, episodeGapMs: 600, now: () => at });
  assert.equal(frameRms(new Int16Array([0, 0, 0])), 0);
  assert.equal(clock.observe(new Int16Array([2000, -2000])).speechStartAt, 1000);
  at = 1040;
  assert.equal(clock.observe(new Int16Array([2500, -2500])).lastSpeechAt, 1040);
  at = 1900;
  const next = clock.observe(new Int16Array([2500, -2500]));
  assert.equal(next.episode, 2);
  assert.equal(next.speechStartAt, 1900);
});

test('PCM16 WAV round-trip and resampling support reproducible human audio input', () => {
  const pcm = Int16Array.from([0, 1000, -1000, 2000, -2000, 0]);
  const wav = encodeWavPcm16(pcm, 16000);
  assert.deepEqual(inspectWav(wav), {
    audioFormat: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataBytes: 12, dataOffset: 44, durationMs: 0,
  });
  const decoded = decodeWavPcm16(wav, 24000);
  assert.equal(decoded.sampleRate, 24000);
  assert.equal(decoded.pcm.length, 9);
});

test('scorer keeps STT, latency, booking, and interruption measurements separate', () => {
  const corpus = { cases: [{ id: 'a', category: 'darija', modality: 'speech', accepted: ['نحب موعد'] }] };
  const score = scoreBenchmark({
    corpus,
    results: [{ caseId: 'a', transcript: 'نحب موعد', entitiesTotal: 1, entitiesCorrect: 1, firstAudioMs: 900, turnLatencyMs: 1400, bookingSuccess: true, slotsTotal: 4, slotsCorrect: 4, unsafeWrite: false, interruptionStopMs: 120, resumeSuccess: true, nativeTunisianRating: 4.5, languageAppropriateness: 4.5, nonTunisianDrift: false }],
  });
  assert.equal(score.stt.overallWer, 0);
  assert.equal(score.stt.criticalEntityAccuracy, 1);
  assert.equal(score.latency.firstAudioP95Ms, 900);
  assert.equal(score.booking.successRate, 1);
  assert.equal(score.booking.slotAccuracy, 1);
  assert.equal(score.booking.unsafeWriteRate, 0);
  assert.equal(score.interruption.stopP95Ms, 120);
  assert.equal(score.interruption.resumeSuccess, 1);
  assert.equal(score.naturalness.nativeTunisianMos, 4.5);
  const gate = evaluateAcceptance(score, fixture('acceptance.json'));
  assert.equal(gate.status, 'pending', 'unmeasured code-switch gates cannot be reported as passed');
});

test('benchmark provider pins fail closed instead of rotating to a fallback', () => {
  assert.deepEqual(availableStt({ voiceBenchmarkMode: true, voiceBenchmarkSttProvider: 'deepgram', deepgramApiKey: 'x' }), ['deepgram']);
  assert.throws(() => availableStt({ voiceBenchmarkMode: true, voiceBenchmarkSttProvider: 'deepgram' }), /DEEPGRAM_API_KEY/);
  assert.deepEqual(availableLlm({ voiceBenchmarkMode: true, voiceBenchmarkLlmProvider: 'gemini-flash-lite-latest', geminiApiKey: 'x' }), ['gemini-flash-lite-latest']);
  assert.throws(() => availableLlm({ voiceBenchmarkMode: true, voiceBenchmarkLlmProvider: 'classic' }), /remote LLM/);
  assert.throws(() => createTtsChain({ config: { voiceBenchmarkMode: true }, clinic: {} }), /VOICE_BENCHMARK_TTS_PROVIDER/);
  const unresolved = resolveVoiceBrainMode({ config: { voiceBenchmarkMode: true, voiceBrain: 'cascade' }, clinic: {} });
  assert.equal(unresolved.mode, 'cascade', 'a broken benchmark must never be relabelled as a Live sample');
  assert.match(unresolved.reason, /benchmark TTS/);
});

test('tunisian-first prompt policy explicitly blocks regional drift and preserves code-switching', () => {
  const block = languagePolicyBlock('ar', 'Tunisian Arabic (ar-TN)', 'tunisian-first');
  assert.match(block, /Tunisian Darija/);
  assert.match(block, /Libyan/);
  assert.match(block, /French or English loanwords/);
  assert.match(block, /return with them/);
});
