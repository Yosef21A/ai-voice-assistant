# V7 A/B results — cascade vs live

Appended by `scripts/cascade-ab.js`. Every row is ONE run of N synthetic calls
against a locally running server on ONE brain (VOICE_BRAIN is read at boot, so a
per-call flip is impossible). The caller is an in-process werift peer sending a
440 Hz tone, so the plumbing columns are measured end to end while the model
columns are read back off the call records the server wrote.

| when | mode | calls ok | connect p50 | greeting p50 / p95 | turn p50 / p95 | rec turns | llm_ttft p50 | tts_ttfb p50 | first_audio p50 / p95 | chain |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 2026-08-02 00:16 | `cascade` | 10/10 | 82 | 136 / 2444 | n/a / n/a | 0 | n/a | n/a | n/a / n/a | liveEars → n/a → fish |
