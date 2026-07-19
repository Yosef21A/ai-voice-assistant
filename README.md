# omen-clinic-agent

A **WhatsApp AI agent for medical-tourism clinics** in Tunisia (Sousse / Sfax),
built for Libyan patients booking treatment abroad. It is **multi-tenant** and
converses in **Arabic, French, and English** — detecting the patient's language,
answering FAQs from each clinic's knowledge base, quoting prices, handling
travel/accommodation questions, escalating to a human, and driving a full
**appointment booking** to a confirmed record.

> **Runs 100% offline in "mock mode"** — no API keys, no network, no database,
> no build step. `npm install` pulls a single dependency (`express`), and even
> that is only needed for the HTTP server; the demo and tests run on plain Node.

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

---

## Project layout

```
whatsapp-clinic-agent/
├── package.json          # scripts: start · simulate · test  (dep: express)
├── .env.example          # documented, all-optional variables
├── data/
│   └── clinics.json      # 2 seed tenants: El Amen (Sousse), Ennour (Sfax)
├── src/
│   ├── server.js         # Express: /webhook, /simulate, /health
│   ├── simulate.js       # CLI end-to-end demo (AR + FR + EN)
│   ├── config.js         # env + tiny .env loader (no dotenv dep)
│   ├── engine/           # language, intent, slots, datetime, booking, faq, …
│   ├── llm/              # provider interface + mock + anthropic
│   └── store/            # JSON-file store + availability
└── test/                 # node:test — language, intent, booking
```

---

## Run it

Requires **Node.js ≥ 18** (for global `fetch` and the built-in test runner).

```bash
npm install          # installs express (0 native deps, 0 build step)

npm run simulate     # scripted Arabic + French bookings, end-to-end, offline
npm test             # unit tests (node:test): language, intent, full booking
npm start            # start the Express server on :3000
```

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
`test/language.test.js` (detection), `test/intent.test.js` (routing), and
`test/booking.test.js` (two full multi-turn bookings across both tenants, state
persistence, cancel, and out-of-hours auto-adjustment into a valid slot) — all on
the built-in `node:test` runner, no extra install.

---

## License

UNLICENSED — internal OmenLabz prototype.
