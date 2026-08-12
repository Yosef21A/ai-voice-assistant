#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { decodeWavPcm16, evaluateAcceptance, inspectWav, scoreBenchmark, sha256, validateSuite } from '../src/voice-call/benchmark.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = path.join(ROOT, 'benchmark', 'tunisian-voice');

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    out[key.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function present(value) {
  return Boolean(String(value || '').trim());
}

function providerReadiness(config) {
  const recommendedLiveModel = 'gemini-3.1-flash-live-preview';
  return {
    cascadeTarget: {
      stt: { provider: 'deepgram', credential: 'DEEPGRAM_API_KEY', ready: present(config.deepgramApiKey) },
      llm: { provider: 'gemini-flash-lite-latest', credential: 'GEMINI_API_KEY', ready: present(config.geminiApiKey) },
      tts: {
        provider: 'azure',
        credentials: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],
        ready: present(config.azureSpeechKey) && present(process.env.AZURE_SPEECH_REGION),
        voice: 'ar-TN-ReemNeural',
      },
    },
    liveControl: {
      provider: 'gemini-live',
      credential: 'GEMINI_API_KEY',
      credentialReady: present(config.geminiApiKey),
      requestedModel: config.geminiLiveModel,
      recommendedModel: recommendedLiveModel,
      configurationReady: present(config.geminiApiKey) && config.geminiLiveModel === recommendedLiveModel,
    },
    optionalChallengers: {
      speechmatics: present(config.speechmaticsApiKey),
      fish: present(config.fishAudioApi),
      elevenlabs: present(config.elevenlabsApiKey),
    },
  };
}

function inventoryAudio(dir, corpus) {
  if (!dir) return { directory: null, files: [], missingSpeechCases: corpus.cases.filter((row) => row.modality === 'speech').map((row) => row.id) };
  const absolute = path.resolve(dir);
  const files = existsSync(absolute) ? readdirSync(absolute).filter((name) => /\.wav$/i.test(name)) : [];
  const rows = files.map((name) => {
    const buffer = readFileSync(path.join(absolute, name));
    try {
      const info = inspectWav(buffer);
      decodeWavPcm16(buffer, info.sampleRate);
      return { file: name, sha256: sha256(buffer), ...info, valid: true };
    } catch (error) {
      return { file: name, sha256: sha256(buffer), valid: false, error: error.message };
    }
  });
  const captured = new Set(files.map((name) => name.split('__')[0]));
  return { directory: absolute, files: rows, missingSpeechCases: corpus.cases.filter((row) => row.modality === 'speech' && !captured.has(row.id)).map((row) => row.id) };
}

function gitState() {
  try {
    return {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()),
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

const args = argsOf(process.argv.slice(2));
const corpusFile = path.join(SUITE, 'corpus.json');
const scenariosFile = path.join(SUITE, 'scenarios.json');
const clinicFile = path.join(SUITE, 'clinic.json');
const acceptanceFile = path.join(SUITE, 'acceptance.json');
const protocolFile = path.join(SUITE, 'protocol.json');
const raw = {
  corpus: readFileSync(corpusFile), scenarios: readFileSync(scenariosFile), clinic: readFileSync(clinicFile), acceptance: readFileSync(acceptanceFile), protocol: readFileSync(protocolFile),
};
const corpus = JSON.parse(raw.corpus);
const scenarios = JSON.parse(raw.scenarios);
const clinic = JSON.parse(raw.clinic);
const acceptance = JSON.parse(raw.acceptance);
const protocol = JSON.parse(raw.protocol);
const validation = validateSuite({ corpus, scenarios, clinic, acceptance, protocol });
const config = getConfig();
const results = args.results ? json(path.resolve(String(args.results))) : [];
const score = results.length ? scoreBenchmark({ corpus, results }) : null;
const output = {
  kind: args.results ? 'scored-provider-run' : 'dry-validation',
  measurement: Boolean(args.results),
  generatedAt: new Date().toISOString(),
  suite: { name: 'tunisian-voice', schemaVersion: corpus.schemaVersion, hashes: Object.fromEntries(Object.entries(raw).map(([name, buffer]) => [name, sha256(buffer)])) },
  source: gitState(),
  validation,
  providers: providerReadiness(config),
  audio: inventoryAudio(args['audio-dir'], corpus),
  score,
  acceptance: score ? evaluateAcceptance(score, acceptance) : null,
  note: results.length ? null : 'Dry validation only: no provider was called and no quality or latency target was measured.',
};
const captureRoot = path.resolve(String(args.out || config.voiceBenchmarkCaptureDir || path.join(ROOT, 'data', 'runtime', 'voice-benchmark')));
const runId = `baseline-${output.generatedAt.replace(/[:.]/g, '-')}`;
mkdirSync(captureRoot, { recursive: true });
const outputFile = path.join(captureRoot, `${runId}.json`);
writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ ...output, artifact: outputFile }, null, 2));
process.exit(validation.ok ? 0 : 1);
