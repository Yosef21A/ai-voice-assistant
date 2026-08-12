import { createHash } from 'node:crypto';

const ARABIC_MARKS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/gu;

export function normalizeTranscript(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_MARKS, '')
    .replace(/ـ/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .replace(/[-–—_/.,!?؟،:;()[\]{}'"«»]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function wordErrorRate(reference, hypothesis) {
  const a = normalizeTranscript(reference).split(' ').filter(Boolean);
  const b = normalizeTranscript(hypothesis).split(' ').filter(Boolean);
  if (!a.length) return b.length ? 1 : 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, prev.length, ...row);
  }
  return prev[b.length] / a.length;
}

export function bestWer(accepted = [], hypothesis = '') {
  const refs = Array.isArray(accepted) && accepted.length ? accepted : [''];
  return Math.min(...refs.map((reference) => wordErrorRate(reference, hypothesis)));
}

export function percentile(values, p) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  return rows[Math.min(rows.length - 1, Math.max(0, Math.ceil(p * rows.length) - 1))];
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function inspectWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('WAV is shorter than its minimum header');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('audio must be a RIFF/WAVE file');
  }
  let offset = 12;
  let format = null;
  let dataBytes = null;
  let dataOffset = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw new Error(`truncated WAV chunk ${id}`);
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') {
      dataBytes = size;
      dataOffset = start;
    }
    offset = start + size + (size % 2);
  }
  if (!format || dataBytes == null) throw new Error('WAV needs fmt and data chunks');
  const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
  return { ...format, dataBytes, dataOffset, durationMs: Math.round((dataBytes / bytesPerSecond) * 1000) };
}

export function decodeWavPcm16(buffer, targetRate = 24000) {
  const info = inspectWav(buffer);
  if (info.audioFormat !== 1 || info.bitsPerSample !== 16) throw new Error('WAV must be uncompressed PCM16');
  const frames = Math.floor(info.dataBytes / (2 * info.channels));
  const mono = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < info.channels; channel += 1) {
      sum += buffer.readInt16LE(info.dataOffset + (frame * info.channels + channel) * 2);
    }
    mono[frame] = Math.round(sum / info.channels);
  }
  if (info.sampleRate === targetRate) return { pcm: mono, sampleRate: targetRate, source: info };
  const length = Math.max(1, Math.round((mono.length * targetRate) / info.sampleRate));
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = (i * info.sampleRate) / targetRate;
    const left = Math.min(mono.length - 1, Math.floor(position));
    const right = Math.min(mono.length - 1, left + 1);
    const fraction = position - left;
    pcm[i] = Math.round(mono[left] * (1 - fraction) + mono[right] * fraction);
  }
  return { pcm, sampleRate: targetRate, source: info };
}

export function encodeWavPcm16(pcm, sampleRate, channels = 1) {
  const input = pcm instanceof Int16Array ? pcm : Int16Array.from(pcm || []);
  const dataBytes = input.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < input.length; i += 1) buffer.writeInt16LE(input[i], 44 + i * 2);
  return buffer;
}

export function validateSuite({ corpus, scenarios, clinic, acceptance, protocol }) {
  const errors = [];
  const cases = corpus?.cases;
  if (!Array.isArray(cases) || !cases.length) errors.push('corpus.cases must be non-empty');
  const ids = new Set();
  for (const row of cases || []) {
    if (!row?.id || ids.has(row.id)) errors.push(`invalid or duplicate case id: ${row?.id || '(missing)'}`);
    ids.add(row?.id);
    if (!['speech', 'silence', 'text'].includes(row?.modality)) errors.push(`${row?.id}: unsupported modality`);
    if (!Array.isArray(row?.accepted) || !row.accepted.length) errors.push(`${row?.id}: accepted references required`);
  }
  for (const scenario of scenarios?.scenarios || []) {
    if (!scenario?.id) errors.push('scenario id required');
    for (const caseId of scenario?.turns || []) if (!ids.has(caseId)) errors.push(`${scenario.id}: unknown case ${caseId}`);
  }
  const benchmarkClinic = clinic?.clinic || clinic?.clinics?.[0];
  if (clinic?.clinics && clinic.clinics.length !== 1) errors.push('benchmark clinic file must contain exactly one tenant');
  if (benchmarkClinic?.timezone !== 'Africa/Tunis') errors.push('benchmark clinic timezone must be Africa/Tunis');
  if (benchmarkClinic?.voiceLanguagePolicy !== 'tunisian-first') errors.push('benchmark clinic must pin tunisian-first policy');
  if (!acceptance?.targets?.stt || !acceptance?.targets?.latency) errors.push('acceptance targets incomplete');
  if ((protocol?.recording?.nativeSpeakersMin || 0) < 3) errors.push('recording protocol needs at least three native speakers');
  if (protocol?.humanNaturalness?.phase !== 7 || protocol?.humanNaturalness?.status !== 'not-started') {
    errors.push('human naturalness A/B must remain deferred to phase 7');
  }
  const required = ['darija', 'code_switch_fr', 'code_switch_en', 'arabizi', 'name', 'number', 'date', 'booking', 'correction', 'interruption', 'silence', 'greeting', 'goodbye', 'natural_speech', 'french', 'english'];
  const categories = new Set((cases || []).map((row) => row.category));
  for (const category of required) if (!categories.has(category)) errors.push(`missing category ${category}`);
  return { ok: errors.length === 0, errors, cases: cases?.length || 0, scenarios: scenarios?.scenarios?.length || 0 };
}

function mean(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

export function scoreBenchmark({ corpus, results = [] }) {
  const byId = new Map((corpus?.cases || []).map((row) => [row.id, row]));
  const scored = [];
  for (const result of results) {
    const testCase = byId.get(result.caseId);
    if (!testCase) continue;
    scored.push({ ...result, category: testCase.category, wer: bestWer(testCase.accepted, result.transcript) });
  }
  const speech = scored.filter((row) => byId.get(row.caseId)?.modality === 'speech');
  const categories = {};
  for (const category of new Set(speech.map((row) => row.category))) {
    categories[category] = { count: speech.filter((row) => row.category === category).length, wer: mean(speech.filter((row) => row.category === category).map((row) => row.wer)) };
  }
  const entityRows = scored.filter((row) => Number.isFinite(row.entitiesTotal) && row.entitiesTotal > 0);
  const entityTotal = entityRows.reduce((sum, row) => sum + row.entitiesTotal, 0);
  const entityCorrect = entityRows.reduce((sum, row) => sum + (Number(row.entitiesCorrect) || 0), 0);
  const bookingRows = results.filter((row) => typeof row.bookingSuccess === 'boolean');
  const slotRows = results.filter((row) => Number.isFinite(row.slotsTotal) && row.slotsTotal > 0);
  const slotsTotal = slotRows.reduce((sum, row) => sum + row.slotsTotal, 0);
  const slotsCorrect = slotRows.reduce((sum, row) => sum + (Number(row.slotsCorrect) || 0), 0);
  const writeRows = results.filter((row) => typeof row.unsafeWrite === 'boolean');
  const interruptionRows = results.filter((row) => Number.isFinite(row.interruptionStopMs));
  const resumeRows = results.filter((row) => typeof row.resumeSuccess === 'boolean');
  const naturalRows = results.filter((row) => Number.isFinite(row.nativeTunisianRating));
  return {
    casesScored: scored.length,
    stt: {
      overallWer: mean(speech.map((row) => row.wer)),
      darijaWer: mean(speech.filter((row) => row.category === 'darija').map((row) => row.wer)),
      codeSwitchWer: mean(speech.filter((row) => row.category === 'code_switch_fr' || row.category === 'code_switch_en').map((row) => row.wer)),
      byCategory: categories,
      criticalEntityAccuracy: entityTotal ? entityCorrect / entityTotal : null,
    },
    latency: {
      firstAudioP50Ms: percentile(results.map((row) => row.firstAudioMs), 0.5),
      firstAudioP95Ms: percentile(results.map((row) => row.firstAudioMs), 0.95),
      turnP50Ms: percentile(results.map((row) => row.turnLatencyMs), 0.5),
      turnP95Ms: percentile(results.map((row) => row.turnLatencyMs), 0.95),
    },
    booking: {
      evaluated: bookingRows.length,
      successRate: bookingRows.length ? bookingRows.filter((row) => row.bookingSuccess).length / bookingRows.length : null,
      slotAccuracy: slotsTotal ? slotsCorrect / slotsTotal : null,
      unsafeWriteRate: writeRows.length ? writeRows.filter((row) => row.unsafeWrite).length / writeRows.length : null,
    },
    interruption: {
      evaluated: interruptionRows.length,
      stopP95Ms: percentile(interruptionRows.map((row) => row.interruptionStopMs), 0.95),
      resumeSuccess: resumeRows.length ? resumeRows.filter((row) => row.resumeSuccess).length / resumeRows.length : null,
    },
    naturalness: {
      evaluated: naturalRows.length,
      nativeTunisianMos: mean(naturalRows.map((row) => row.nativeTunisianRating)),
      languageAppropriateness: mean(naturalRows.map((row) => row.languageAppropriateness)),
      nonTunisianDriftRate: naturalRows.length
        ? naturalRows.filter((row) => row.nonTunisianDrift === true).length / naturalRows.length
        : null,
    },
  };
}

export function evaluateAcceptance(score, acceptance) {
  const t = acceptance?.targets || {};
  const checks = {
    overallWer: [score?.stt?.overallWer, t?.stt?.overallWerMax, 'max'],
    darijaWer: [score?.stt?.darijaWer, t?.stt?.darijaWerMax, 'max'],
    codeSwitchWer: [score?.stt?.codeSwitchWer, t?.stt?.codeSwitchWerMax, 'max'],
    criticalEntityAccuracy: [score?.stt?.criticalEntityAccuracy, t?.stt?.criticalEntityAccuracyMin, 'min'],
    firstAudioP50Ms: [score?.latency?.firstAudioP50Ms, t?.latency?.firstAudioP50MsMax, 'max'],
    firstAudioP95Ms: [score?.latency?.firstAudioP95Ms, t?.latency?.firstAudioP95MsMax, 'max'],
    turnP50Ms: [score?.latency?.turnP50Ms, t?.latency?.turnP50MsMax, 'max'],
    turnP95Ms: [score?.latency?.turnP95Ms, t?.latency?.turnP95MsMax, 'max'],
    bookingSlotAccuracy: [score?.booking?.slotAccuracy, t?.booking?.slotAccuracyMin, 'min'],
    bookingSuccess: [score?.booking?.successRate, t?.booking?.endToEndSuccessMin, 'min'],
    unsafeWriteRate: [score?.booking?.unsafeWriteRate, t?.booking?.unsafeWriteRateMax, 'max'],
    interruptionStopP95Ms: [score?.interruption?.stopP95Ms, t?.interruption?.stopP95MsMax, 'max'],
    interruptionResume: [score?.interruption?.resumeSuccess, t?.interruption?.resumeSuccessMin, 'min'],
    nativeTunisianMos: [score?.naturalness?.nativeTunisianMos, t?.naturalness?.nativeTunisianMosMin, 'min'],
    languageAppropriateness: [score?.naturalness?.languageAppropriateness, t?.naturalness?.languageAppropriatenessMin, 'min'],
    nonTunisianDriftRate: [score?.naturalness?.nonTunisianDriftRate, t?.naturalness?.nonTunisianDriftRateMax, 'max'],
  };
  const rows = Object.fromEntries(
    Object.entries(checks).map(([name, [actual, target, direction]]) => [
      name,
      {
        actual: Number.isFinite(actual) ? actual : null,
        target: Number.isFinite(target) ? target : null,
        direction,
        status: !Number.isFinite(actual) || !Number.isFinite(target) ? 'pending' : direction === 'max' ? (actual <= target ? 'pass' : 'fail') : (actual >= target ? 'pass' : 'fail'),
      },
    ])
  );
  const statuses = Object.values(rows).map((row) => row.status);
  return { status: statuses.includes('fail') ? 'fail' : statuses.includes('pending') ? 'pending' : 'pass', checks: rows };
}
