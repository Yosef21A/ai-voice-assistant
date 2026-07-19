# CLAUDE.md — Omen Clinic Concierge

## What this project is
A WhatsApp AI receptionist for medical clinics and medical-tourism facilitators (Tunisia–Libya corridor). Patients message a clinic's WhatsApp; the agent replies in 3 seconds in Arabic/French/English, answers FAQs, books appointments, and captures medical-tourism leads. Sold as SaaS (setup fee + monthly). Built by OmenLabz (founder: Youssef, Sousse).

**`PRODUCT-SPEC.md` is the source of truth for WHAT to build. Read it before planning any feature work.** Business pricing/tiers live in `docs/pricing-and-packaging.md`. Production deployment + full Meta WhatsApp Cloud API onboarding: `deploy/RUNBOOK.md`.

## Current state (working prototype — do not regress it)
- Pure Node.js, ES Modules, single dependency (`express`). No build step. Runs fully offline in mock mode.
- `npm install && npm run simulate` → scripted AR + FR conversations complete real bookings end-to-end.
- `npm test` → 17/17 passing (node:test). Keep it green; add tests with every feature.
- WhatsApp Cloud API webhook implemented but never connected to a real number yet.
- LLM abstracted behind a provider interface: deterministic `mockProvider` (default) + `anthropicProvider` (fetch-based, untested against the live API — needs wiring + per-tenant KB prompt work).
- Persistence = JSON files (`src/store/`). Fine for demo; Phase 1 migrates to Postgres.

## Architecture map
- `src/server.js` — Express: GET/POST `/webhook` (Meta verify + inbound), `POST /simulate`, `GET /health`. Inbound payloads normalized to a transport-agnostic shape.
- `src/engine/` — the brain: `language.js` (AR/FR/EN detection), `intent.js`, `booking.js` (stateful booking state machine), `slots.js`, `datetime.js`, `faq.js`, `responses.js` (all localized reply templates), `index.js` (orchestrator).
- `src/llm/` — provider interface; engine works 100% deterministically without any API key.
- `src/store/` — JSON store + `availability.js` (working-hours check). Keep this interface when swapping to Postgres so the engine doesn't change.
- `data/clinics.json` — multi-tenant registry keyed by WhatsApp `phone_number_id` (becomes the `tenants` table).
- `src/simulate.js` — CLI demo. `test/` — engine tests. `deploy/` — PM2/Nginx/SSL/env + RUNBOOK.

## What to build (order matters — from PRODUCT-SPEC.md §8)
1. **Phase 1 (sellable pilot):** Postgres migration → auth + tenants → onboarding wizard (spec §2, steps 1–6 + sandbox) → live inbox with human takeover → appointments view → owner notifications via WhatsApp → first real number connected (RUNBOOK §E).
2. **Phase 2 (renewal engine):** analytics + money line, template reminders with confirm buttons, "bot didn't know" training loop, weekly digest, leads pipeline.
3. **Phase 3 (scale):** Meta Tech Provider + Embedded Signup, facilitator mode, campaigns, billing.

## Engineering rules (founder's standards)
- Process: Issue Analysis → Root Cause → Scalable Fix → Optimization → Testing. No patchwork; no fragile fixes.
- Deliver complete files, never fragments. Readable > clever. Boring tech that scales > fashionable tech.
- Multi-tenancy: every query scoped by tenant; tenant resolution stays keyed on `phone_number_id`.
- The engine must stay transport-agnostic (webhook, simulator, sandbox all feed the same normalized shape).
- JSON store ⇒ SINGLE PM2 instance only (documented in RUNBOOK). After Postgres, this constraint lifts.
- Stack for the dashboard: Next.js (App Router) with proper AR/RTL i18n, or keep it lean per spec §7. Postgres 16 (founder already runs it). SSE preferred for live inbox behind Nginx.

## Non-negotiable product guardrails (medical context)
- The bot NEVER diagnoses, never promises outcomes, never gives personalized exact prices — "from" prices + human-quote flow only. Enforce in code/system prompt, not just config.
- Emergency keywords → immediate emergency-number reply + staff alert; bot steps back.
- Patient data belongs to the clinic: export + deletion supported; media (X-rays) stored safely; assistant discloses it's an assistant.
- 24h service window vs approved template messages (reminders) — respect Meta rules; Oct 1, 2026 service-message billing change is passed through to clients contractually.

## Commands
- `npm run simulate` — end-to-end scripted demo (must always work offline)
- `npm test` — full suite (keep green)
- `npm start` — webhook server on :3000

## Context docs in this repo
- `PRODUCT-SPEC.md` — full product spec: wizard, dashboard screens, take-my-money features, phases
- `docs/pricing-and-packaging.md` — tiers, founding-clinic offer (do NOT invent new prices)
- `deploy/RUNBOOK.md` — VPS + Meta onboarding, §E is the real-number connection guide
- `README.md` — original prototype docs
