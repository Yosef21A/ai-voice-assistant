# PHASE-2 WORKPLAN — advance the bot in all directions
> The complete, ordered build plan for the next Claude Code sessions. Read after `CLAUDE.md` + `docs/HANDOFF-STATE.md`. Baseline at time of writing: commit `f9605c4`, **97 pass / 0 fail / 1 skip**, live loop verified end-to-end (WhatsApp → Meta → tunnel → engine (Gemini) → reply), dashboard SPA live on :3000.

## Operating rules for every session (non-negotiable)
1. **Servers are yours to run** — start `npm start` and `cloudflared tunnel --url http://localhost:3000` as background tasks at session start; watch their logs. If the tunnel URL rotates, update the Meta webhook yourself via Chrome (you did it before: app → WhatsApp → Étape 2 → Configurer des webhooks; verify token `<redacted-verify-token>`) AND check the `messages` field stays **Abonné(e)**.
2. **Hermetic tests** — `npm test` green before AND after every slice (baseline 97/1 skip; PG suite runs only with `DATABASE_URL`). Never regress `npm run simulate`.
3. **Commit per slice** with clear messages. NEVER commit `.env`, `claudechat.md`, `cloudflare_terminal.md`, `data/runtime/*`, `data/media/*` (gitignored).
4. **Token ritual (until production):** the WhatsApp token dies ~24h. On Graph 401: regenerate in console Étape 1 (popup), paste into `.env`, restart `npm start`. Consider surfacing 401s as a dashboard toast + owner-log line (see P2-F).
5. **Medical guardrails** (CLAUDE.md) apply to every feature: no diagnosis, no exact personal prices, emergency override stays intact — add regression tests when touching the pipeline.
6. Engine stays transport-agnostic; store access only through the store interface (JSON today, PG after P1-G).

## Build order (do them in this order)
| # | Slice | Why this order |
|---|---|---|
| 1 | **P2-A Analytics & stats** | The owner-facing "is it worth it" screen — sells pilots and renewals; needs only existing data |
| 2 | **P2-D Media / X-ray intake** | Highest wow + real medical-tourism need; unblocks better leads |
| 3 | **P2-B "Bot didn't know" training loop** | Makes the bot improve weekly; churn killer |
| 4 | **P2-C Leads pipeline screen** | Converts tourism inquiries into tracked money |
| 5 | **P2-F Hardening & ops** | Before any real clinic traffic |
| 6 | **P1-G Postgres primary** | Before multi-clinic load; schema already exists (P1-A) |
| 7 | **P2-G Dialect & LLM polish** | Continuous; big chunk here |
| 8 | **P2-E Reminders & templates** | Full value needs the production number; build engine now, activate later |
| 9 | **P2-H Production cutover** | RUNBOOK §E when first paying clinic signs |

---

## P2-A — Analytics & stats dashboard (the owner's ROI screen)
**Backend** — `GET /api/stats?from&to` (tenant-scoped, aggregated from the store):
- `conversationsByHour[24]` + `afterHoursShare` (outside tenant working hours — reuse availability.js)
- `responseTime` (median inbound→first-outbound delta), `conversationCount`, `messageCount`
- `languageSplit` {ar,fr,en}, `topIntents[]`, `topQuestions[]` (from message/intent logs; extend events.json logging if a field is missing — additively)
- funnel: conversations → bookingStarted → bookingConfirmed (+ statuses: done/no_show/cancelled from appointments)
- `estimatedValue` = confirmedBookings × `tenant.config.avgBookingValue` (add to tenant config + Settings UI; default null → hide money line)
- digest parity: reuse the same aggregation for daily/weekly digests (`src/notifications/`) so numbers always match.
**Frontend** — new "Statistiques" screen (route + sidebar entry, AR/FR/EN + RTL): metric cards row, 24h heatmap bar strip with after-hours band highlighted, language donut (inline SVG — zero new deps), funnel bars, top-questions list, date-range picker (7/30/90d), and the money line rendered LARGE with the after-hours callout ("41% de vos patients écrivent hors horaires"). Empty states for fresh tenants.
**Tests**: aggregation unit tests on a seeded fixture store (deterministic dates), API auth/tenant-scoping, after-hours math across midnight, funnel math.
**Done when**: seeded fixture renders correct numbers; live tenant shows real conversation stats; digests reuse the same module.

## P2-D — Media / X-ray intake
- Webhook: handle `image` / `document` (+`audio` voice notes: store + show player) message types: fetch media URL via Graph (`GET /{media-id}` then binary download with token), save under `data/media/{tenantId}/{yyyymm}/` with UUID names; enforce type allowlist + size cap (~10MB); never trust filenames.
- Store: message records get `{type, mediaPath, mimeType, caption}`; patient/lead cards list attachments.
- Inbox UI: thumbnails for images, file chip for PDFs, audio player for voice notes; click = open full (auth-gated media route `GET /api/media/...` — NEVER serve data/ statically).
- Bot behavior: on receiving media in a quote/tourism flow → acknowledge in patient language ("وصلتنا الصورة، الطبيب يشوفها ويرد عليك") + emit `lead.hot` + owner notification 📎; media NEVER interpreted medically (guardrail).
- Retention: config `mediaRetentionDays` (default 90) + purge cron; export/delete included in patient-data deletion path.
- Tests: webhook media payload fixture → file persisted + message record + notification emitted (Graph fetch mocked); auth on media route; purge logic.

## P2-B — "Bot didn't know" training loop
- Engine: when reply comes from fallback (mock or Gemini with no KB grounding) → append to `unanswered` store collection {tenantId, question, lang, count, conversationRef, status:new|answered|ignored}; dedupe near-identical questions (normalized).
- Dashboard: Knowledge screen gains "À entraîner" tab with badge count → owner types the answer (per language, auto-draft translations via provider, editable) → saves as KB entry → engine serves it immediately (KB lookup precedes LLM).
- KB integration check: ensure `faq.js`/engine actually consult `kb_entries` created from the dashboard (P1-D noted engine didn't read them yet — THIS slice closes that gap; wizard KB + trained answers become live bot knowledge).
- Metric: unknownRate into P2-A stats + weekly digest ("le bot a appris 7 nouvelles réponses cette semaine").
- Tests: unknown capture, dedupe, KB entry answering the same question afterwards (end-to-end through engine).

## P2-C — Leads pipeline screen
- Backend: leads collection already exists — add `status` transitions (new → contacted → quoted → negotiating → booked → arrived → lost), `assignee`, `notes[]`, `value` estimate, `waitingSince` for "waiting on you" (patient answered, human owes reply — derive from last message direction on hot/quote conversations).
- UI: "Leads" screen — kanban-lite columns (drag or move-buttons), red timer chip on waiting-on-you > 30min, lead card = patient info + procedure + origin + attachments + conversation link + one-tap WhatsApp open. SSE keeps it live (`lead.hot` already flows).
- Stats hook: pipeline conversion + total pipeline value into P2-A.
- Tests: transitions, waiting-on-you derivation, tenant scoping.

## P2-F — Hardening & ops (before real clinic traffic)
- Webhook: dedupe by `wa message id` (seen-set with TTL) — Meta retries cause double-processing today; return 200 fast, process async.
- Rate limiting per wa_id (e.g. 20 msg/min → polite throttle reply once) + global inbound cap; body-size limits.
- Structured JSON logging (zero-dep): request line, engine decision, Graph result, latency; log file rotation (or PM2 logrotate note in deploy/).
- Graph 401/expired-token → one owner-visible alert (dashboard toast via bus + log), not silent failure.
- Store backups: nightly zip of `data/` (script + cron line in deploy/), restore doc.
- Boot-time env validation with actionable errors; `GET /health` extended (store writable, tunnel-independent).
- Dashboard security pass: cookie flags in prod, basic security headers, login rate-limit, audit events for takeover/sends.
- Tests: dedupe, rate limit, boot validation.

## P1-G — Postgres primary (existing slice, unchanged scope)
Engine request path → async store interface; `DATABASE_URL` flips PG to primary end-to-end; JSON stays the offline/dev default; migration script for existing runtime JSON → PG (`scripts/db-import-json.js`); RUNBOOK cutover section. All 97+ tests green both modes; PG suite un-skips with `DATABASE_URL`.

## P2-G — Dialect & LLM polish (continuous)
- `responses.js`: Libyan-colloquial AR variant set behind tenant config `dialect: "ly" | "tn" | "msa"`; review every patient-facing string with that lens.
- Gemini system prompt: per-tenant persona (name/tone from wizard), KB grounding, strict guardrail preamble (no diagnosis/prices), output-length discipline; localized emergency message audit.
- Golden-transcript tests: scripted AR(ly)/AR(tn)/FR conversations asserted end-to-end (mock provider) so prompt/template changes can't silently break flows.

## P2-E — Reminders & template engine
- Build now: reminder scheduler (node-cron exists in digests) — T-48h + T-3h jobs per confirmed appointment, quiet-hours aware, dedupe, cancel-on-status-change; interactive confirm/cancel button replies handled in webhook → appointment status + owner notify.
- Constraint: custom template messages require the PRODUCTION number (test number only has Meta's samples). Until then: send reminders free-form ONLY when inside the 24h service window, else queue-and-skip with a log. Template manager UI (create/submit via Graph) ships behind a "production" flag.
- Tests: scheduling math, window logic, button-reply handling.

## P2-H — Production cutover (when first clinic signs)
RUNBOOK §E end-to-end: VPS deploy (deploy/ kit), dedicated number + permanent System-User token, business verification (needs the OmenLabz portfolio — payment-flag appeal), webhook on real domain + TLS (no tunnel), template approvals, PG primary on, backups + monitoring on, pass-through billing clause active (Oct 1, 2026).

---

## Suggested kickoff prompt (paste into Claude Code)
```
Read CLAUDE.md, docs/HANDOFF-STATE.md, then docs/PHASE2-WORKPLAN.md fully.
Start npm start and the cloudflared tunnel as background tasks; if the tunnel
URL rotated, update the Meta webhook yourself in Chrome per the workplan rules
and confirm the messages field is still subscribed. Run npm test (expect 97
pass / 1 skip). Then execute the workplan IN ORDER starting with P2-A
(analytics): plan it first, then implement, tests green, commit per slice.
Follow the operating rules at the top of the workplan at all times.
```
