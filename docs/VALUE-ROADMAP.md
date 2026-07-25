# VALUE-ROADMAP — make the bot worth more money (fresh session orders, 2026-07-23)
> Read after CLAUDE.md + docs/HANDOFF-STATE.md. This SUPERSEDES the ordering of NEXT-WORK.md (its Task 0 is inherited below; its P2-F/P1-G land mid-roadmap; slice DETAILS in PHASE2-WORKPLAN.md still apply where referenced). Baseline: 37 commits, 252 tests passing / 1 skip, humanize live, real WhatsApp line working.

## Why these slices (CEO logic — read this to build with intent)
The pricing card (`docs/pricing-and-packaging.md`) SELLS: voice-note understanding (Growth), no-show reminders (Growth), CRM/Sheets sync (Growth), Instagram (add-on), recall campaigns (add-on). Today the bot does none of these. Rule #1 of value: **ship what the price list promises.** Rule #2: **capture revenue the clinic can feel** (fewer no-shows, revived silent leads → numbers on the Stats screen). Rule #3: **wow moments sell demos** (a bot that understands a Libyan voice note closes meetings by itself).

## Execution order
| # | Slice | Value lever |
|---|---|---|
| 0 | Close uncommitted WIP (NEXT-WORK Task 0) | Clean tree, honest history |
| 1 | **V1 Voice-note understanding** | Growth-tier promise + the demo wow |
| 2 | **V2 Reminders & no-show killer** | Growth-tier promise + measurable ROI (−35–50% no-shows) |
| 3 | **V4 Smart follow-ups (never let a lead die)** | Direct revenue capture |
| 4 | **P2-F ops hardening** (PHASE2-WORKPLAN §P2-F; audit what adversarial passes already did) | Reliability = sellability |
| 5 | **P1-G Postgres primary** (PHASE2-WORKPLAN §P1-G) | Scale + real-client readiness |
| 6 | **V6 Owner copilot** | Dashboard wow + stickiness |
| 7 | **V7 Webhook/CSV export (CRM sync v1)** | Growth-tier promise, lean version |
| — | Later (do NOT start): Instagram/Messenger channel (needs Meta app review), facilitator multi-clinic mode, per-doctor calendars/waitlist, TTS voice replies | Phase-3 territory |

---

## V1 — Voice-note understanding (STT via Gemini audio)
**Why:** Libyan/Tunisian patients default to voice notes. Today we store them and say "a human will listen." Growth tier PROMISES understanding. Gemini 2.5 Flash accepts audio natively (ogg/opus = WhatsApp's format) on the same free key.
**Build:**
- Extend the P2-D media path: inbound `audio` → (existing) Graph download → transcribe via Gemini (inline audio + instruction to transcribe in original language; expect Tunisian/Libyan Arabic, French, code-switching) → feed the transcript into the SAME humanize pipeline as if typed (flag `source:'voice'` in context so the bot can say "سمعتك 👌").
- **Dialect-STT humility guardrail:** when acting on a voice-derived slot (date/specialty/name), the bot confirms naturally before locking critical slots ("فهمت اللي تحب موعد أسنان الخميس، صحيح؟"). Low-confidence/failed transcription → warm fallback: "سمعت الرسالة أما ما فهمتش مليح 🙏 تنجم تعاودها ولا تكتبلي؟" — NEVER silent, NEVER pretend.
- Inbox: transcript rendered under the existing audio player (staff gold). Store transcript on the message record.
- Classic mode / no key: current behavior (ack + human) unchanged. Timeouts/size caps (voice ≤ 2 min transcribed; longer → human handoff note).
- **Tests:** fake provider audio path (transcript → pipeline), failure fallback, confirmation-before-lock policy, inbox render, classic regression.
**Done when:** you send a real Libyan-Arabic voice note asking for a dental appointment and the bot answers correctly in chat, transcript visible in inbox.

## V2 — Reminders & no-show killer (P2-E, elevated)
Spec base: PHASE2-WORKPLAN §P2-E (scheduler T-48h/T-3h, quiet hours, cancel-on-status-change, confirm/cancel replies → status + owner notify, 24h-window rule: free-form only when window open, template manager behind production flag).
**Value additions:**
- **Stats integration:** reminder outcomes (sent/confirmed/cancelled/no-answer) + no-show rate trend on the Stats screen — this graph IS the renewal pitch.
- Same-day "on my way?" optional T-3h variant with buttons; reschedule request → conversational reschedule via humanize (availability-checked).
- Owner settings UI: toggles, times, quiet hours per tenant.
**Tests:** scheduling math incl. DST/timezone (Africa/Tunis), window logic, button replies, stats math.

## V4 — Smart follow-ups: never let a lead die
**Why:** the transcript proved it — patients say "الو" and vanish. Silent leads are money on the floor. Automate the "never let clients go" instinct.
**Build:**
- Outcome-aware nudges, all INSIDE the 24h service window, quiet-hours aware, **max 1 nudge per conversation**, instant opt-out respected ("لا شكراً" → never again):
  - Lead interested (price/procedure asked) + silent ≥ N hours (default 4, config) → ONE contextual nudge via humanize ("سي {name}, بخصوص {procedure} — تحب نحجزولك ولا عندك سؤال؟ 🙌").
  - Booking mid-flow abandoned ≥ 2h → gentle resume with kept slots.
  - Post-visit (appointment date passed, status=done) → care message + review ask (only if window open; else queue for template/production flag like V2).
- Owner toggles per nudge type; every nudge logged + shown in conversation thread; stats: nudges → replies → bookings (conversion of revived leads).
- **Tests:** trigger conditions, single-nudge cap, opt-out, window/quiet-hours gating, stats.
**Done when:** a test lead goes silent after a price question and gets exactly one smart nudge 4h later (clock injectable for tests/live-demo speed).

## V6 — Owner copilot ("ask your clinic")
- `POST /api/copilot {question}` (owner role): builds a compact context from the EXISTING stats module + recent leads/appointments summaries (tenant-scoped, no raw patient dumps) → Gemini → grounded answer with numbers ("هذا الأسبوع: 34 محادثة، 6 حجوزات، 3 منهم من ليبيا…").
- UI: small chat box on the Stats screen ("اسأل عيادتك"). Read-only, logged, rate-limited. Graceful "I don't have that data" honesty rule in the prompt.
- **Tests:** fake provider grounding (answers must cite provided numbers only), tenant isolation, role gate.

## V7 — CRM sync v1 (lean, honest)
- Outbound **signed webhooks** per tenant (Settings UI: URL + secret): POST JSON on `appointment.created/updated` and `lead.*` with HMAC-SHA256 signature header, retries with backoff, delivery log in dashboard.
- **CSV export** buttons (appointments/leads, date-range, UTF-8 BOM for Excel-Arabic).
- `docs/integrations.md`: 10-minute Google Sheets recipe via Apps Script receiving the webhook (no Google OAuth complexity in-product yet — honest v1).
- **Tests:** signature, retry, tenant scoping, CSV correctness (Arabic intact).

---

## Standing rules (unchanged, enforced every session)
Background servers + tunnel-rotation webhook update yourself · token ritual (~24h, surface 401s) · suite green (252 pass / 1 skip baseline) + simulate offline-green · medical guardrails are law (no diagnosis, "from" prices, deterministic emergency override) + regression tests when touching the pipeline · tenant scoping everywhere · commit per slice, never `.env` · live sanity check on the real line after each slice · rename stale `.git/*.lock` aside if the mount blocks unlink.

## Kickoff prompt (paste into Claude Code)
```
Read CLAUDE.md, docs/HANDOFF-STATE.md, then docs/VALUE-ROADMAP.md — execute it
top to bottom starting with slice 0 (close the uncommitted WIP). For each
slice: plan first, implement complete files, add the listed tests, keep the
suite green and simulate offline-green, commit, then do a quick live check on
the real WhatsApp line (I'll send voice notes and test messages when you ask).
Where the roadmap references PHASE2-WORKPLAN.md sections, follow those specs.
Audit-don't-assume on P2-F. Never weaken medical guardrails.
```
