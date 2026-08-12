// Caller-side acoustic timing shared by both voice brains.
//
// Transcription timestamps are too late for perceived-latency measurement: an
// STT provider first waits for silence, then emits a final. This clock observes
// decoded inbound PCM before STT and remembers the last frame that contained
// caller speech. It is deliberately only instrumentation; it never decides a
// turn, books anything, or interrupts the agent.

export const DEFAULT_SPEECH_RMS = 1200;
export const DEFAULT_SPEECH_EPISODE_GAP_MS = 600;

/** Root-mean-square level of one PCM16 frame. */
export function frameRms(int16) {
  if (!int16 || !int16.length) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i += 1) sum += int16[i] * int16[i];
  return Math.sqrt(sum / int16.length);
}

/**
 * Passive speech-episode clock.
 *
 * `lastSpeechAt` is the timestamp benchmarks use as caller speech offset. A new
 * high-energy frame after `episodeGapMs` begins a new episode; ordinary pauses
 * inside a sentence keep the same episode. The clock accepts an explicit `at`
 * so unit tests and replay harnesses can be deterministic.
 */
export function createAcousticClock({
  rmsThreshold = DEFAULT_SPEECH_RMS,
  episodeGapMs = DEFAULT_SPEECH_EPISODE_GAP_MS,
  now = () => Date.now(),
} = {}) {
  const threshold = Math.max(1, Number(rmsThreshold) || DEFAULT_SPEECH_RMS);
  const gap = Math.max(0, Number(episodeGapMs) || DEFAULT_SPEECH_EPISODE_GAP_MS);
  let episode = 0;
  let speechStartAt = 0;
  let lastSpeechAt = 0;
  let voicedFrames = 0;

  function observe(pcm, at = now()) {
    const rms = frameRms(pcm);
    if (rms < threshold) return { voiced: false, rms, ...snapshot() };
    const stamp = Number(at) || now();
    if (!lastSpeechAt || stamp - lastSpeechAt > gap) {
      episode += 1;
      speechStartAt = stamp;
    }
    lastSpeechAt = stamp;
    voicedFrames += 1;
    return { voiced: true, rms, ...snapshot() };
  }

  function snapshot() {
    return { episode, speechStartAt, lastSpeechAt, voicedFrames, rmsThreshold: threshold, episodeGapMs: gap };
  }

  return { observe, snapshot };
}
