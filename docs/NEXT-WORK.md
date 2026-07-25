# NEXT-WORK — orders for the next Claude Code session (2026-07-23)
> Read after CLAUDE.md. This supersedes the ordering in PHASE2-WORKPLAN.md and the backlog in HANDOFF-2026-07-20.md (both remain valid for slice DETAILS; this file decides WHAT'S NEXT). HANDOFF-STATE.md still holds the live Meta wiring facts + token ritual.

## Where the repo stands (verified 2026-07-23)
- 36 commits. Since Phase-1: auth malleability fix → **P2-A analytics** (backend + Stats screen + 9-finding hardening) → **P2-D media/X-ray/voice intake** (+ retention purge, 5 findings) → **P2-B training loop** ("À entraîner" queue; KB finally live in the engine; 13 findings) → **P2-C leads kanban** (7 findings) → **P2-HUMANIZE complete** (digit/datetime F4 fix, seed F8 fix, Gemini structured output, humanize core with deterministic executor + guardrails, WhatsApp niceties + gap alerts, 42 replay/safety tests → 196 pass, PROMPT-NOTES.md, adversarial hardening, live fix "bot silently ran classic", retry + Arabizi dates).
- **UNCOMMITTED WIP on disk:** `src/notifications/detector.js`, `src/engine/humanize/guardrails.js`, `test/notifications.detector.test.js` (+116 lines — looks like an emergency/hot-lead detector upgrade mid-flight).

## Task 0 — close the open work (do this first)
Inspect the uncommitted diff, finish or trim it to coherent scope, make the suite green, commit with an honest message. Never leave the tree dirty between sessions.

## Task 1 — P2-F: ops hardening (details in PHASE2-WORKPLAN.md §P2-F)
The last gate before real clinic traffic. Verify which items the adversarial passes already covered — audit, don't assume; then close the gaps:
webhook dedupe by wa message id (Meta retries!), fast-200 + async processing, per-wa_id rate limiting, body-size caps, structured JSON logs + rotation, Graph-401 surfaced as dashboard toast + owner-visible warning (token ritual), nightly `data/` backup script + restore doc, boot-time env validation, security pass (cookie flags, headers, login rate-limit, takeover audit events). Tests per item.

## Task 2 — P1-G: Postgres primary (details in PHASE2-WORKPLAN.md §P1-G)
Engine request path → async store interface; `DATABASE_URL` flips PG end-to-end; `scripts/db-import-json.js` migrates existing runtime JSON; RUNBOOK cutover section; PG suite un-skips green; JSON stays offline default; simulate stays offline-green.

## Task 3 — P2-E: reminder engine (details in PHASE2-WORKPLAN.md §P2-E)
Scheduler (T-48h/T-3h), quiet hours, cancel-on-status-change, confirm/cancel button replies → status + owner notify; free-form only inside the 24h window until the production number exists; template manager behind a "production" flag. Tests: scheduling math, window logic, button handling.

## Task 4 — dialect depth (P2-G remainder)
Golden-transcript tests for Libyan vs Tunisian registers through the humanize pipeline (FakeStructuredProvider); audit every patient-facing string + the emergency messages with the dialect lens; per-tenant `dialect` config honored end-to-end.

## Standing rules (every session)
- Run `npm start` + `cloudflared tunnel` in background yourself; if the tunnel URL rotates, update the Meta webhook in Chrome and confirm the `messages` field stays subscribed (HANDOFF-STATE.md).
- Token dies ~24h → regenerate in console, paste to `.env`, restart (surface 401s per Task 1).
- Suite green before/after every slice (baseline 241 pass / 1 skip). `npm run simulate` must stay offline-green (classic mode).
- Medical guardrails are law: no diagnosis, "from" prices only, emergency override deterministic. Add regression tests when touching the pipeline.
- Commit per slice. Never commit `.env` / session logs. Rename stale `.git/*.lock` aside if the mount blocks unlink.
- After each slice: quick live sanity on the real line (send a message, watch logs) — live truth beats green tests.

## NOT this session (needs the founder / business steps)
Production cutover (P2-H): VPS deploy, real number + permanent System-User token, business verification (payment-flag appeal on the founder's FB account), Tech Provider registration, template approvals. The founder drives these; code support comes from `deploy/RUNBOOK.md`.

## Kickoff prompt (paste into Claude Code)
```
Read CLAUDE.md, docs/HANDOFF-STATE.md, then docs/NEXT-WORK.md — execute
NEXT-WORK in order starting with Task 0 (close the uncommitted WIP on disk).
Plan each task before coding, audit-don't-assume where the spec says so, keep
the suite green (247 pass / 1 skip baseline) and simulate offline-green, run the servers in
the background yourself, and do a quick live sanity check on the real WhatsApp
line after each slice. Commit per slice.
```
