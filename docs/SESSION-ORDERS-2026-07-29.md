# SESSION ORDERS — 2026-07-29 (market pivot + roadmap continuation)
> Read after CLAUDE.md + docs/HANDOFF-STATE.md (start-up ritual!). This supersedes VALUE-ROADMAP.md ORDERING; its slice specs (V2, V4, V6, V7) and PHASE2-WORKPLAN specs (P2-F, P1-G) remain the reference. Founder is away for hours — work autonomously, but leave nothing dirty and log what you verified live.

## State (audited this morning)
- Baseline: **272 pass / 0 fail / 1 skip**, tree clean at `c84adf7`.
- Done since roadmap: WIP closed (spelled prices, Arabizi emergencies, cross-line bypass), emergency detection moved BEFORE the LLM + localized, **V1 voice complete** (transcription → humanize pipeline, humility guardrail, inbox transcript).
- Pending from roadmap: V2 reminders, V4 follow-ups, P2-F ops audit, P1-G Postgres, V6 copilot, V7 CRM sync.
- Market discovery (founder, field truth): **Tunisian clinics don't take booking calls — the doctors' own cabinets do.** Targets are now (a) individual doctors/cabinets and (b) medical-tourism facilitator agencies. Both. The product must demo perfectly to BOTH personas.

## Execution order for this session
**D1 → V2 → D2 → V4 → P2-F → P1-G → V6 → V7** (D1 is small — ship it first so the doctor demo exists today; V2 closes the Growth-tier promise; D2 opens the agency market; V4 captures revenue; then plumbing and polish.)

---

## D1 — Cabinet mode (single-doctor practice) — NEW, do first
**Why:** the buyer is a doctor, not a clinic switchboard. A doctor's bot must never ask "which specialty?" — there is one. The persona is *the doctor's assistant*, by name.
**Build (additive, no breaking changes):**
1. Tenant `type: "clinic" | "cabinet" | "facilitator"` (default `"clinic"` when absent — zero migration).
2. Specialty question is SKIPPED whenever the tenant has exactly one specialty OR `type:"cabinet"` — in BOTH humanize context (slot pre-filled, prompt says so) and classic flow. Generalize: any tenant, if the patient's message already implies the specialty, never ask (assert existing humanize behavior with a test).
3. Persona defaults for cabinets: "مساعد عيادة الدكتور {doctorName}" / "Assistant du Dr {doctorName}" — greeting, handoff lines, and confirmation summary name the doctor. `config.doctorName` (wizard + settings).
4. Wizard: profile step variant when type=cabinet — doctor name + single specialty + hours (no multi-specialty checklist). Dashboard copy adapts ("Rendez-vous du Dr {name}").
5. Seed a 3rd tenant for demos: `cabinet-bensalem-sousse` — "Cabinet Dr. Ben Salem — Cardiologie" (spare phone_number_id `1000000003`), realistic KB/prices/hours.
**Tests:** AR + FR cabinet booking end-to-end never asks specialty (humanize FakeStructuredProvider + classic); persona naming in greeting/confirmation; wizard variant persists; clinic-type regression untouched.
**Done when:** `npm run simulate` gains a cabinet scenario that books without a specialty question, and the live line (temporarily keying El Amen → type cabinet in a LOCAL test, then reverting) shows the doctor persona.

## V2 — Reminders & no-show killer
Spec: VALUE-ROADMAP §V2 (+ PHASE2-WORKPLAN §P2-E). Timezone Africa/Tunis. Stats screen gets the no-show trend + reminder outcomes. Buttons confirm/cancel handled in webhook. Free-form only inside the 24h window (production/template flag for the rest). Owner toggles in Settings.

## D2 — Facilitator mode MVP (medical-tourism agencies) — NEW
**Why:** agencies already broker these patients commercially over WhatsApp; the same bot sells to them as a 24/7 qualification concierge. (Full multi-clinic quote comparison stays Phase 3 — this is the honest MVP.)
**Build:**
1. `type:"facilitator"` tenants: NO local availability/booking paths (appointment flow unreachable); the conversation goal becomes **qualification**: procedure, origin city/country, travel window, budget signal, invite medical report/X-ray upload (media path exists), contact → rich LEAD via the existing pipeline + owner alert. Reply framing: "نلقاولك أحسن عيادة ونرجعولك بعرض اليوم إن شاء الله."
2. `config.partners[]` (name, city, specialties) — informational routing hint rendered on the lead card ("candidats: Clinique X, Y"), NO partner messaging.
3. Wizard variant: agency name, destinations, procedures covered, optional partners list. Dashboard for facilitators is leads-first (Leads = home; Appointments hidden).
4. Seed a 4th tenant: `medtour-tripoli-sousse` facilitator demo (spare pnid `1000000004`).
**Tests:** qualification end-to-end produces a complete lead + alert; booking intents get concierge framing not slots; type gating on dashboard nav + API; clinic/cabinet regressions green.
**Done when:** simulate gains a facilitator scenario ending in a rich lead, and the Leads board shows it with the partner hint.

## V4 — Smart follow-ups
Spec: VALUE-ROADMAP §V4. NOTE for facilitators this is the quote-chaser — make the nudge templates persona-aware (cabinet: doctor's assistant voice; facilitator: agency concierge voice).

## P2-F → P1-G → V6 → V7
Per PHASE2-WORKPLAN §P2-F (audit-don't-assume; include Gemini daily-quota exhaustion surfacing — the bot has silently fallen to classic before, HANDOFF-STATE notes it) and §P1-G; then VALUE-ROADMAP §V6/§V7. V6 copilot + V7 webhooks must be tenant-type aware (facilitator stats speak leads/quotes, not bookings).

## Standing rules
HANDOFF-STATE start-up ritual (kill stale :3000, tunnel, webhook re-entry + verify token, subscribed_apps check) · WhatsApp-Web-in-Chrome may be used for live tests without the founder · token ~24h ritual · suite green (272/1 baseline) + simulate offline-green · medical guardrails are law + regression tests · tenant scoping · commit per slice · never `.env` · stale `.git/*.lock` → rename aside.

## Kickoff prompt (paste into Claude Code)
```
Read CLAUDE.md, docs/HANDOFF-STATE.md (do its start-up ritual now), then
docs/SESSION-ORDERS-2026-07-29.md — execute its order D1 → V2 → D2 → V4 →
P2-F → P1-G → V6 → V7 autonomously for the next hours. Plan each slice first,
complete files, listed tests added, suite green (272/1 baseline) and simulate
offline-green after every slice, commit per slice with honest messages. Do
live sanity checks via WhatsApp Web in Chrome after D1, V2 and D2. If the
Gemini daily quota dies mid-session, note it, keep building — classic mode
covers the demos. Never weaken medical guardrails.
```
