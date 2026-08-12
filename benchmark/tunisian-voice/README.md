# Tunisian Voice Quality Baseline

This suite is a versioned, provider-neutral baseline for `ar-TN`. It does not
start a human A/B and its dry run does not call a provider.

## Contents

- `clinic.json`: isolated `Africa/Tunis` tenant, deterministic slots, explicit
  `tunisian-first` policy, target Azure voice, and app-compatible `clinics`
  shape. Benchmark mode selects it and a separate runtime directory by default.
- `corpus.json`: 24 spoken/silence cases plus four Arabizi text controls.
- `scenarios.json`: deterministic booking, correction, interruption, silence,
  language-switch, and goodbye flows.
- `acceptance.json`: the gates agreed for the first measured baseline.
- `protocol.json`: speaker coverage, recording format, repetition/randomization,
  cache rules, and the explicitly deferred rank-7 blind human rubric.

## Dry validation

Run `npm run benchmark:voice`. It validates references and scenario links,
reports credential readiness without printing secret values, hashes every suite
input, records the Git revision/dirty flag, and writes a manifest below the
gitignored `data/runtime/voice-benchmark/` directory. The result says
`measurement: false`; it must never be quoted as provider performance.

To inventory recordings without sending them anywhere:

```text
npm run benchmark:voice -- --audio-dir C:\path\to\speaker-wavs
```

Recordings use `audio/<case-id>__<speaker-id>.wav`. WAV files must be uncompressed
PCM, mono, 16-bit, preferably 16 kHz or 24 kHz. Keep speaker consent beside the
corpus outside Git. Do not commit patient or evaluator recordings.

To score a later provider result file:

```text
npm run benchmark:voice -- --results C:\path\to\results.json
```

Results are a JSON array. Each row needs `caseId` and `transcript`; optional
fields are `entitiesTotal`, `entitiesCorrect`, `firstAudioMs`, `turnLatencyMs`,
`bookingSuccess`, `slotsTotal`, `slotsCorrect`, `unsafeWrite`,
`interruptionStopMs`, and `resumeSuccess`. Human rows may add
`nativeTunisianRating`, `languageAppropriateness`, and `nonTunisianDrift`.
Naturalness remains a human rubric
and is intentionally not synthesized by this command.

## Measurement boundary

First-audio latency starts at the last caller frame above the acoustic threshold
and ends at the first semantic response frame. Filler audio is reported
separately as first-any-audio. Turn latency uses the same caller stop and the end
of semantic response. The benchmark stores both requested and resolved provider
model identifiers when the provider returns them. Benchmark mode pins every
cascade leg and refuses fallback, so a quota or credential failure is a failed
sample rather than a contaminated comparison.

The Live control must also pin `GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview`.
The application default is intentionally unchanged by this baseline work; the
dry manifest marks the control unready until the current model is explicit.
