# Omen Clinic Concierge — Product Spec v1
### The bot + self-serve admin dashboard that makes a clinic owner say "take my money"

> Hand this file to the Claude Code session building the product. The existing prototype in this repo (engine, tests, deploy kit) is the foundation — this spec defines what gets built ON TOP of it.

---

## 0. The product in one line

A clinic (or medical-tourism facilitator) signs up, connects their WhatsApp number through a guided wizard, fills in their clinic info once — and from that moment their WhatsApp answers every patient in Arabic/French/English in 3 seconds, books appointments, captures leads, and reports everything in a live dashboard that notifies the owner when money walks in.

---

## 1. WhatsApp 101 — how bots work here (vs Telegram)

Telegram hands anyone a free bot API token. WhatsApp does NOT work that way — there is no hobby bot API. The official path is the **WhatsApp Business Platform (Cloud API)**, hosted by Meta:

- The clinic has a **WhatsApp Business Account (WABA)** + a phone number registered on the API (a number on the API can't simultaneously be a normal WhatsApp app number).
- Your server receives patient messages via **webhook** (already built in `src/server.js`) and replies via HTTP calls with an access token.
- **Free-form replies are allowed within a 24h "service window"** after the patient's last message. Outside that window you can only send pre-approved **template messages** (this is what appointment reminders use).
- **Pricing:** inbound + service replies are effectively free today; Meta starts charging for service messages **Oct 1, 2026** → keep the pass-through clause in contracts (already in the GTM docs).

**The key 2026 fact for OUR onboarding dream:** Meta now mandates the **Tech Provider** model with **Embedded Signup** — an official OAuth popup you put INSIDE your dashboard. The client clicks "Connect WhatsApp," logs into Facebook, picks/creates their number, and Meta wires their WABA to your app automatically. Out of the box you can onboard **10 customers per rolling 7 days** (200 after your app passes Business Verification + App Review). Bonus: the client attaches THEIR payment method to THEIR WABA, so Meta's message costs bill the clinic directly — your margin stays clean.

**Strategy:**
- **Clients 1–10 (now):** "concierge onboarding" — a 30-minute guided call where you connect their number together. Don't frame it as a limitation; sell it as white-glove service. The dashboard wizard still does everything else.
- **Scale (later):** integrate Embedded Signup so the wizard is 100% self-serve. Register as Tech Provider early — verification takes weeks; start the clock now.

---

## 2. The onboarding wizard — "from signup to live bot"

One linear flow, progress bar, every step skippable-and-return-later except the WhatsApp connect. Target: **live in under 20 minutes.**

1. **Account** — email + password (or WhatsApp-number OTP login — on brand), clinic vs facilitator account type. Language of the dashboard itself: AR / FR / EN.
2. **Clinic profile** — name, city, address + Google Maps link, phone, specialties (checklist with the common ones pre-listed: dental, cosmetic, cardiology, orthopedics, fertility, ophthalmology…), working hours per day, holiday dates.
3. **Languages & persona** — which languages the bot speaks (AR/FR/EN toggles), bot display name ("Assistant Clinique El Amen"), tone (professional / warm), greeting message preview that updates live as they type.
4. **Knowledge base** — the heart. Three ways to fill it, easiest first:
   - **Specialty templates:** picking "dental" pre-loads 25 real Q&As (prices format, implant process, duration, anesthesia, aftercare…) they just edit.
   - **Paste-your-prices:** a simple table editor (procedure / price-from / currency / notes). "Price from" framing avoids exact-quote liability.
   - **Free Q&A editor:** add any question/answer pair, per language (auto-translate draft with one click, human-editable).
5. **Medical-tourism module** (toggle, on by default for this niche) — origin countries served, "can patient send X-ray/photos?" yes routes media to staff, partner hotels/transport info, visa/border FAQ, quote-request flow settings (what info to collect before a human quotes).
6. **Escalation rules** — human handoff WhatsApp number(s), what triggers handoff (patient asks for human, anger detected, emergency keywords, question the bot can't answer twice), emergency message ("for emergencies call ‹number› now"), staff hours vs bot-only hours.
7. **Connect WhatsApp** — Embedded Signup popup (later) or "book your 30-min connection call" scheduler (now). Shows number status: connected / pending / test mode.
8. **Test drive** — a built-in sandbox chat (reuse `clinic-agent-demo` UI) preloaded with THEIR data: "Ask your bot anything before going live." This is the take-my-money moment — they see their own clinic answering perfectly.
9. **Go live** — one switch. Confetti. First-week checklist shown (tell reception the bot exists, put the number on Instagram bio, etc.).

---

## 3. The dashboard — screens and why each one sells

### 3.1 Live Inbox (the screen they'll live in)
- All conversations, WhatsApp-style, real-time (SSE/WebSocket), unread counts, filters (language, status, needs-human, booking-stage).
- **Human takeover — THE killer feature:** one tap pauses the bot on that conversation and staff types directly (via the same Cloud API); bot auto-pauses the moment a staff member replies from the dashboard; one tap hands back to the bot. Badge shows who's driving: 🤖 / 👤.
- Per-conversation lead card in a side panel: name, origin city/country, procedure interest, extracted phone, appointment status, full history.
- Internal notes on conversations (staff-only, yellow sticky style).

### 3.2 Appointments
- Day/week calendar + list view, statuses (pending / confirmed / done / no-show / cancelled), created-by (bot vs staff), one-tap confirm/cancel that ALSO messages the patient.
- Availability editor feeding the bot's slot suggestions (working hours now; per-doctor calendars = v2).
- Export CSV. Google Calendar sync = v2.

### 3.3 Leads (medical-tourism pipeline)
- Every quote request / travel inquiry becomes a lead card: procedure, origin, budget signals, requested info, X-ray/photo attachments, status (new → quoted → negotiating → booked → arrived).
- "Waiting on you" tray: leads where the patient answered everything and a HUMAN must send the quote — with elapsed-time timer (speed = money in this corridor).

### 3.4 Analytics (the renewal engine — this screen justifies month 2, 3, 12)
- Conversations by hour heatmap with the **after-hours share highlighted** ("41% of your patients wrote while you were closed").
- Response time: bot avg (~3s) vs their old baseline (from the mystery-shop log if available).
- Language split, top-10 asked questions, booking conversion funnel (conversations → info collected → booked), no-show rate trend once reminders are on.
- **The money line:** estimated captured value = bookings × their configured avg procedure value. Shown huge. "This month: ≈ 8,400 TND captured." Renewals close themselves.
- Weekly PDF/WhatsApp digest auto-sent to the owner (see 3.6).

### 3.5 Knowledge & training loop
- Edit any Q&A live; changes apply instantly.
- **"Bot didn't know" queue:** every question the bot couldn't answer confidently lands here; owner types the answer once; bot knows it forever. This makes the product get smarter weekly and makes the owner invested (their work compounds INTO your product = churn killer).
- Test box on every screen ("try it") so edits can be verified immediately.

### 3.6 Notifications (meet them where they live: their own WhatsApp)
- The admin's alert channel IS WhatsApp — the platform messages the owner's personal number. Zero new apps to check. Configurable events:
  - instant: new booking ✅, hot lead (asked about a high-value procedure) 🔥, human-handoff requested 🙋, emergency keyword 🚨, X-ray received 📎
  - digests: morning summary (yesterday's numbers), weekly report with the money line
- Quiet hours, per-event toggles, multiple recipients (owner + reception). Email as fallback.

### 3.7 Reminders & campaigns (template messages)
- Appointment reminders: T-48h and T-3h templates (AR/FR), confirm/cancel buttons → status updates automatically. This alone cuts no-shows 35–50% (cited in `research/01-market-opportunity-report.md`) — make it a headline feature.
- Post-visit follow-up (aftercare + review ask), pre-arrival travel checklist for tourism patients, "we miss you" reactivation (v2).
- Template manager: pre-written approved-format templates per specialty; submission to Meta handled behind a simple UI.

### 3.8 Settings & team
- Everything from the wizard, editable. Vacation mode (bot announces closure dates). Multiple staff logins with roles (owner / reception). Billing page (their plan, invoices — Payoneer link now, card later).

---

## 4. "Take my money" ranked feature list

**Demo-day closers (must exist for the first sale):**
1. Their own clinic answering perfectly in Libyan-friendly Arabic in the sandbox, 20 minutes after signup
2. Human takeover from the live inbox
3. Instant WhatsApp notification to the owner on every booking
4. The after-hours heatmap + captured-value money line
5. Appointment reminders with confirm buttons

**Sticky (kill churn):**
6. "Bot didn't know" training loop
7. Leads pipeline with the waiting-on-you timer
8. Weekly WhatsApp digest with the money line

**Premium/upsell (Concierge tier):**
9. Facilitator mode: multi-clinic routing + comparative quote collection
10. Campaigns/broadcasts, multi-branch, per-doctor calendars, API/export

---

## 5. Trust & safety (medical context — non-negotiable)
- The bot NEVER diagnoses, never promises medical outcomes, never quotes exact personalized prices — only "from" prices + human quote flow. Hard-coded guardrails + system prompt, not just config.
- Emergency keywords (bleeding, chest pain, faint…) → immediate emergency-number message + staff alert, bot steps back.
- Data: conversations belong to the clinic; export + delete-on-request built in; media (X-rays) stored encrypted, auto-purge policy configurable; clear privacy line in patient-facing first message ("assistant" disclosure — also builds trust).
- Rate limiting + spam filtering on inbound; profanity/abuse deflection.

---

## 6. Pricing gates (map to existing `pricing-and-packaging.md` tiers)
- **Pilot:** inbox, bookings, notifications, 1 language pack beyond Arabic, 1 staff seat.
- **Growth:** + analytics, reminders, training loop, 3 seats.
- **Concierge:** + campaigns, facilitator/multi-branch, priority support, custom flows.
Founding-clinic pricing already defined in GTM — don't invent new numbers.

---

## 7. Architecture notes for the build session
- **Keep the engine.** `src/engine/` (intent, booking state machine, language) already works and is tested — the dashboard is a new layer, not a rewrite. Real LLM provider (`src/llm/anthropicProvider.js`) needs wiring + prompt work with the KB injected per tenant.
- **DB:** move JSON store → **Postgres** (Youssef runs PG16 already). Tables: tenants, users, conversations, messages, appointments, leads, kb_entries, notifications, events. Keep the store interface so the engine doesn't care.
- **Stack suggestion:** Next.js (dashboard, AR/RTL-ready i18n) + existing Express webhook service, or one Node monorepo with two apps. SSE for live inbox (simpler than WS behind Nginx; WS fine too — PM2 single instance assumption already documented in `deploy/RUNBOOK.md`).
- **Auth:** email+password with bcrypt or magic-link; tenant_id scoping on EVERY query; roles owner/staff.
- **Message sending:** one outbound module wrapping Cloud API (text, template, media, buttons) with retry + rate handling; log everything to messages table.
- **Media:** webhook receives X-ray/photo IDs → download from Meta → store (local disk now, S3-compatible later) → show in lead card.
- **Jobs:** node-cron for reminders/digests (MVP-fine); queue later if needed.
- **Multi-tenant routing:** already keyed by `phone_number_id` — keep it.

## 8. Build order (each phase is shippable)
- **Phase 1 — Sellable pilot (target ~2 weeks):** Postgres migration → auth + tenant CRUD → wizard steps 1–6 + 8 (sandbox) → live inbox (read + human takeover) → appointments list → WhatsApp notifications to owner → connect ONE real number manually via `deploy/RUNBOOK.md` §E. This is enough to charge the founding price.
- **Phase 2 — Renewal engine (~2 weeks):** analytics screen + money line, reminders with confirm buttons, training loop, weekly digest, leads pipeline.
- **Phase 3 — Scale:** Tech Provider registration + Embedded Signup in the wizard, facilitator mode, campaigns, billing automation.

## 9. What already exists in this repo (don't rebuild)
- Conversation engine + 17 tests (`src/engine/`, `test/`)
- Webhook server shaped for Meta (`src/server.js`)
- Multi-tenant config pattern (`data/clinics.json` → becomes the tenants table)
- Deploy path to production (`deploy/RUNBOOK.md` — incl. full Meta onboarding §E)
- Sales demo UI to cannibalize for the sandbox (`../clinic-agent-demo/index.html`)
- All pricing/copy (`../../gtm/whatsapp-clinic-agent/`)
