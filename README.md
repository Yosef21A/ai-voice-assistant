# omen-clinic-agent

A **WhatsApp AI agent for medical-tourism clinics** in Tunisia (Sousse / Sfax),
built for Libyan patients booking treatment abroad. It is **multi-tenant** and
converses in **Arabic, French, and English** — detecting the patient's language,
answering FAQs from each clinic's knowledge base, quoting prices, handling
travel/accommodation questions, escalating to a human, and driving a full
**appointment booking** to a confirmed record.

> **Runs 100% offline in "mock mode"** — no API keys, no live WhatsApp, no
> network. Runtime deps are `express` + `pg` (Postgres is opt-in; the default
> JSON store needs nothing). The engine, the CLI demo and the whole test suite
> run on plain Node. The admin **dashboard** is a Vite/React SPA whose only
> footprint is dev-dependencies — `npm run web:build` emits plain static files
> that the same Express server serves at `/`.

This is now a **Phase-1-complete sellable pilot**: the conversational engine, a
multi-tenant dashboard (auth, onboarding wizard, live inbox with human takeover,
appointments, knowledge base, settings), owner **WhatsApp notifications**
(bookings, hot leads, handoffs, emergencies + daily/weekly digests), and the
safety **detectors** (emergency keywords → the bot steps back) are all wired
into one pipeline. See `PRODUCT-SPEC.md` for the full spec and `deploy/RUNBOOK.md`
to connect a real number.

---

## Why it exists (the business)

Tunisian private clinics earn strong margins on international patients but lose
them in the WhatsApp inbox: slow replies, no coverage after hours, no Arabic,
no structured intake. This agent answers in seconds, in the patient's language,
24/7, and hands the clinic a clean, structured booking. One shared codebase
serves many clinics (multi-tenant), so OmenLabz operates it as a per-clinic SaaS.

---

## Architecture

```
                          WhatsApp Cloud API (Meta)
                                   │  inbound webhook (POST /webhook)
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│  src/server.js  (Express — the only place express is used)             │
│   • GET  /webhook   Meta verify handshake (echo hub.challenge)         │
│   • POST /webhook   receive messages  ─┐                               │
│   • POST /simulate  local JSON tester ─┤  normalize → common shape     │
│   • GET  /health    liveness + tenants │                               │
│   • verifySignature()  X-Hub-Signature-256 (HMAC, optional/documented) │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │  { channel, from, text, phoneNumberId }
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│  src/engine/  — transport-agnostic conversation engine                 │
│                                                                        │
│   language.js  script + keyword heuristics → ar | fr | en              │
│   intent.js    greeting · book · pricing · travel · faq · handoff ·    │
│                cancel   (priority-ordered keyword match, 3 languages)  │
│   slots.js     extract specialty / name / origin / contact + yes-no    │
│   datetime.js  parse AR/FR/EN dates & times → resolve a bookable slot  │
│   booking.js   STATE MACHINE: specialty→datetime→name→origin→contact   │
│                →confirm→ create appointment                            │
│   faq.js       match tenant knowledge base, answer in patient's lang   │
│   responses.js localized message templates (ar/fr/en)                  │
│   index.js     handleMessage(): route → reply, persist state           │
└───────────┬───────────────────────────────────────────┬───────────────┘
            │                                             │
            ▼                                             ▼
┌───────────────────────────┐             ┌───────────────────────────────┐
│  src/llm/  (provider seam) │             │  src/store/  (JSON files, fs)  │
│   mockProvider.js  DEFAULT │             │   clinics   (seed, read-only)  │
│   anthropicProvider.js     │             │   patients                     │
│     via global fetch,      │             │   conversations (+state)       │
│     only if ANTHROPIC_API_ │             │   appointments                 │
│     KEY is set; degrades   │             │   availability.js (hours check)│
│     gracefully to mock     │             │                                │
└───────────────────────────┘             └───────────────────────────────┘
```

Design rules that keep it reliable:

- **Booking is fully deterministic.** The LLM provider is used only for
  free-form phrasing (fallbacks). The mock provider alone produces correct
  booking behavior, so the demo and tests never depend on a network call.
- **Transport-agnostic core.** WhatsApp payloads and the `/simulate` endpoint are
  both normalized to one shape, so the engine doesn't know or care about Meta.
- **State per patient** lives on the conversation record in the store, so a
  booking survives across many WhatsApp turns.
- **Multi-tenant by `phone_number_id`.** Each inbound message is routed to a
  clinic via `data/clinics.json → whatsapp.phoneNumberId`.

### Phase-1 platform layer (on top of the engine)

```
 POST /webhook ─┐                    ┌─ src/api/ingest.js ──────────────────────┐
 POST /simulate ┼─ normalized shape ─┤  persist → engine → detectors (beside it)│
 /api/sandbox  ─┘                    │  → send via ONE sender → emit on the bus │
                                     └───────────────┬──────────────────────────┘
   src/whatsapp/ ONE outbound gateway               │  events (tenant-scoped)
     (mock outbox offline · Graph API live)          ▼
   src/events/ in-process bus ──► src/api/stream.js  (SSE)  ──► dashboard live
                              └──► src/notifications/ (owner WhatsApp alerts)
   src/auth/ scrypt + signed-cookie sessions ; src/api/ tenant-scoped REST
   src/store/ json (default) | postgres (opts) — same async interface
   web/ Vite + React SPA (AR/FR/EN + RTL) → built to web/dist, served at /
```

- **Detectors run beside the engine** (`src/notifications/pipeline.js`), never
  inside it, so the engine stays transport-agnostic. An **emergency** overrides
  the engine reply with a localized safety message, pauses the bot, and alerts
  staff (guardrail: never diagnose, step back). A **hot lead** (+ high-value
  procedure / foreign number) pings the owner. Both flow to the live inbox (SSE)
  and the owner's WhatsApp (`src/notifications/service.js`).
- **One bus, one sender.** Every subsystem publishes to `src/events/bus.js`; the
  SSE stream and the notification worker subscribe. Every send (bot, staff,
  owner alert) goes through the single `src/whatsapp` gateway.

---

## Project layout

```
whatsapp-clinic-agent/
├── package.json          # scripts: start · simulate · demo · test · web:build · digest:*
├── .env.example          # documented, all-optional variables
├── data/
│   └── clinics.json      # 2 seed tenants: El Amen (Sousse), Ennour (Sfax)
├── src/
│   ├── server.js         # Express: /webhook, /simulate, /health, /api/*, SPA at /
│   ├── simulate.js       # CLI end-to-end demo (AR + FR + EN + emergency guardrail)
│   ├── config.js         # env + tiny .env loader (no dotenv dep)
│   ├── engine/           # language, intent, slots, datetime, booking, faq, …
│   ├── api/              # ingest pipeline + tenant-scoped REST + sandbox + SSE stream
│   ├── auth/             # scrypt password hashing + signed-cookie sessions
│   ├── events/           # in-process event bus (SSE + notifications subscribe)
│   ├── notifications/    # owner WhatsApp alerts + emergency/hot-lead detectors + digests
│   ├── whatsapp/         # the ONE outbound gateway (mock outbox | Graph API)
│   ├── llm/              # provider interface + mock + anthropic
│   └── store/            # json (default) | postgres adapters, same async interface
├── web/                  # Vite + React dashboard SPA (AR/FR/EN + RTL) → web/dist
├── scripts/              # db:migrate · db:seed · run-digest · seed-demo
├── deploy/               # PM2 · Nginx · TLS · RUNBOOK (VPS + Meta onboarding)
└── test/                 # node:test — engine, store, api, notifications, e2e
```

---

## Run it

Requires **Node.js ≥ 18** (for global `fetch` and the built-in test runner).

```bash
npm install          # express + pg (runtime) and the SPA's dev-only toolchain

npm run simulate     # scripted AR + FR bookings + emergency guardrail, offline
npm test             # full suite (node:test): engine, store, api, notifications, e2e
npm run web:build    # build the dashboard SPA into web/dist (served at /)
npm start            # start the Express server + dashboard on :3000
```

### Bring up the dashboard (first-owner setup)

```bash
npm run web:build        # 1. build the SPA (once, or after web/ changes)
npm start                # 2. server + dashboard on http://localhost:3000
npm run demo             # 3. (optional) seed a demo inbox so it opens looking alive
```

Open `http://localhost:3000`, choose **First-time setup**, and create the owner
account for a seeded clinic ID (`el-amen-sousse` or `ennour-sfax`). That drops
you into the **onboarding wizard** (profile → persona → knowledge → tourism →
escalation → **test drive** → go-live). The wizard's test drive (and Settings →
sandbox) talk to the real engine with your clinic's data — including the
emergency guardrail — without touching the live inbox. From the dashboard you
get the **live inbox** (human takeover), **appointments**, **knowledge base**,
and **notification** preferences. During development, `npm run web:dev` serves
the SPA on :5173 and proxies the API to :3000 (same-origin cookies + SSE).

### The demo (`npm run simulate`)

Drives two full bookings (Arabic → El Amen, French → Ennour) plus an English
concierge showcase (pricing / travel / FAQ / handoff) through the real engine,
then prints the stored appointments and validates that each one is confirmed and
inside the clinic's working hours. Exit code is non-zero if anything is wrong, so
it doubles as a smoke test.

### Poke the running server

```bash
npm start

# health + loaded tenants
curl -s localhost:3000/health

# Meta webhook verification (returns the challenge)
curl -s "localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=omen-verify-dev&hub.challenge=hello"

# talk to the agent without WhatsApp (route to a tenant by phone_number_id)
curl -s -X POST localhost:3000/simulate -H 'Content-Type: application/json' \
  -d '{"from":"218910000001","text":"نحب نحجز موعد قلب","phone_number_id":"1000000001"}'
```

`/simulate` keeps state per `from`, so you can send the booking answers one
message at a time and watch the flow advance to a confirmed appointment.

---

## Languages & intents

| Intent          | Triggers (examples)                                   |
|-----------------|-------------------------------------------------------|
| greeting        | السلام عليكم · Bonjour · Hello                         |
| book_appointment| نحب نحجز موعد · prendre un rendez-vous · book          |
| pricing_quote   | بقداش · quel prix · how much                           |
| travel_help     | فندق/سفر/تأشيرة · hôtel/vol/visa · hotel/flight/visa   |
| faq             | ساعات العمل · horaires · opening hours (+ KB match)   |
| human_handoff   | موظف · conseiller · talk to a human                    |
| cancel          | إلغاء · annuler · cancel                                |

Language is chosen per message (Arabic script → `ar`; French accents/keywords →
`fr`; English keywords → `en`) and **remembered** on the conversation, so short
answers like a name or a phone number stay in the right language.

---

## Configuration

Everything is optional (see `.env.example`). With nothing set, the agent runs in
mock mode and prints outbound replies to the console.

| Variable                   | Purpose                                             |
|----------------------------|-----------------------------------------------------|
| `PORT`                     | HTTP port (default 3000)                            |
| `WHATSAPP_TOKEN`           | Meta permanent token — enables real outbound sends  |
| `WHATSAPP_VERIFY_TOKEN`    | Must match the token entered in Meta webhook setup  |
| `WHATSAPP_PHONE_NUMBER_ID` | Default tenant when a payload has no metadata        |
| `WHATSAPP_APP_SECRET`      | When set, `POST /webhook` enforces the HMAC check    |
| `APP_SECRET`               | Signs dashboard session cookies — set a strong value in prod (distinct from `WHATSAPP_APP_SECRET`) |
| `DATABASE_URL`             | When set, the API/scripts target Postgres (else the JSON store) |
| `ANTHROPIC_API_KEY`        | When set, free-form replies upgrade to Claude        |
| `ANTHROPIC_MODEL`          | Defaults to `claude-3-5-haiku-latest`               |

---

## Path to production

This is a runnable prototype. To take it live:

**1. Meta WhatsApp onboarding**
- Create a Meta App (type *Business*) and add the **WhatsApp** product.
- Register the clinic's business phone number, get its `phone_number_id`, and
  generate a **permanent** system-user access token → `WHATSAPP_TOKEN`.
- Configure the **webhook**: callback URL `https://YOUR_DOMAIN/webhook`, verify
  token = `WHATSAPP_VERIFY_TOKEN`; subscribe to the **messages** field. Meta
  calls `GET /webhook` once to verify (already implemented).
- Set `WHATSAPP_APP_SECRET` to enforce `X-Hub-Signature-256` on every inbound
  payload (`verifySignature()` is already wired in).
- Submit the clinic's message **templates** for approval (needed to start
  conversations outside the 24-hour service window).

**2. LLM**
- Set `ANTHROPIC_API_KEY` to enable Claude for free-form/edge replies. Booking
  logic stays deterministic, so you keep predictable behavior and low cost. Add
  a per-tenant system prompt and RAG over the clinic's docs as a next step.

**3. Deploy on a VPS (PM2 + Nginx)**
```bash
# on an Ubuntu VPS
git clone <repo> && cd whatsapp-clinic-agent && npm ci --omit=dev
npm i -g pm2 && pm2 start src/server.js --name omen-clinic-agent && pm2 save
# Nginx: reverse-proxy 443 → 127.0.0.1:3000, TLS via certbot (Meta requires HTTPS)
```
Add PM2 startup (`pm2 startup`) so it survives reboots. Put the clinic domain
behind Let's Encrypt.

**4. Harden persistence & scale**
- Swap the JSON-file store for Postgres or SQLite (the `src/store` interface is
  the single seam to change — nothing else moves). Add an outbound send queue
  with retries and idempotency on Meta `message.id`.
- **Multi-tenant scaling:** one process already serves every clinic in
  `clinics.json`, routed by `phone_number_id`. Move tenants into the database,
  add an admin API to onboard a clinic (hours, specialties, pricing, KB), and a
  per-tenant analytics dashboard (bookings, response time, deflection rate).

**5. Cost & margin note**
- Infra: a small VPS (~$6–12/mo) hosts many clinics. Meta charges per
  *conversation* (service conversations are low-cost/often free within the
  window; marketing/utility templates are paid, region-priced). LLM spend is
  minimal because booking is rule-based and only fallbacks hit the model
  (haiku-class, fractions of a cent per reply).
- Model: charge each clinic a monthly SaaS fee + setup. With shared infra and
  near-zero marginal LLM cost, gross margin per added clinic is high — the main
  cost is onboarding (KB + templates) which is a one-time productizable task.

---

## Testing

```bash
npm test
```
Full `node:test` suite, no extra install: the engine (`language`, `intent`,
`booking`), the store adapters (`store.adapter.json`, `store.postgres` — the PG
suite skips cleanly without `DATABASE_URL`), the outbound sender, the detectors
(`notifications.detector`), the notification service (`notifications.service`),
the tenant-scoped API + auth + SSE (`api.*`, `web.serving`), and a full-flow
**end-to-end** test (`integration.e2e`) that drives a real booking → owner alert,
staff takeover, an emergency override, and a hot lead through the composed app
(store + engine + bus + mock sender + notification service).

---

## License

UNLICENSED — internal OmenLabz prototype.
