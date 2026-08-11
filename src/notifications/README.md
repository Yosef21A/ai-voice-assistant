# `src/notifications` — Owner notifications + inbound safety/revenue detectors (Phase 1, Slice E)

"Meet the clinic owner where they live: their own WhatsApp." This module turns
domain events (a booking, a hot lead, a human-handoff request, an emergency
keyword) into concise WhatsApp alerts on the owner's / reception's phone, and
runs the two classifiers that make those events fire (PRODUCT-SPEC §3.6, §4, §5).

It is **standalone in P1-E** — every piece is unit-tested in isolation with fake
bus/sender/store — and **wired into the live pipeline in P1-F** (this README is
the wiring contract). Nothing here is imported by `src/server.js`, `src/api/**`
or the engine yet, so it composes cleanly with the concurrent dashboard work.

## Modules

| file | what it is | I/O |
| --- | --- | --- |
| `detector.js` | Pure classifiers: `detectEmergency(text, lang)` (AR incl. Libyan colloquial / FR / EN) and `isHotLead(engineResult, tenantConfig, text, {waId})`. | none |
| `formatter.js` | Pure owner-facing copy in the owner's language (default **FR**): `formatBooking` ✅ / `formatHotLead` 🔥 / `formatHandoff` 🙋 / `formatEmergency` 🚨, plus `formatDailyDigest` / `formatWeeklyDigest` (money line). | none |
| `pipeline.js` | `analyzeInbound(...)` — runs the detectors, emits `lead.hot` / `emergency.detected`, and returns an **`overrideReply`** on emergencies. | emits on bus |
| `service.js` | `createNotificationService({bus, sender, store})` — subscribes to the four instant events, resolves per-tenant recipients + prefs, applies quiet hours + dedupe, sends via the P1-B sender. Plus the pure `computeDigestStats` + `runDailyDigest` / `runWeeklyDigest`. | bus, store, sender |
| `index.js` | Barrel — import everything public from here. | — |

## Event contract (matches `src/events/bus.js`)

Consumed (envelope always carries `{ tenantId, conversationId? }`):

| event | payload | emitted by |
| --- | --- | --- |
| `appointment.created` | `{ appointment }` | `api/ingest.js` (already) |
| `handoff.requested` | `{ handoff, lastMessage?, patientWaId? }` | `api/ingest.js` (already) |
| `lead.hot` | `{ lead }` | **`analyzeInbound` (this module)** |
| `emergency.detected` | `{ keyword, category?, waId?, lang? }` | **`analyzeInbound` (this module)** |

The service also **appends audit rows** to `store.events` for every send
(`notification.sent` / `notification.error`) — it never throws back into a bus
handler.

### Behaviour guarantees (all covered by `test/notifications.service.test.js`)
- **Safe defaults:** a tenant with **no** `notification_prefs` rows still gets
  alerted — the recipient defaults to the clinic's escalation/owner number
  (`config.handoff.phone` / `config.notifications.recipients`), all instant
  events **on**.
- **Quiet hours** suppress every event **except `emergency.detected`**.
- **Dedupe:** the same `conversation + type` inside 10 min is sent once.
- **Per-recipient** language + per-event on/off toggles (explicit `false` = off).
- **Never throws:** formatting/store/send failures are caught and recorded.

---

## Wiring for Slice F (three steps)

### 1. Honor `overrideReply` in the inbound pipeline — `src/api/ingest.js`

`analyzeInbound` runs **beside** the engine (the engine stays transport-agnostic
and never touches the bus). Insert it right after `engine.handleMessage`, and on
an **emergency** send the localized `overrideReply` **instead of** the engine
output — the bot steps back (guardrail: PRODUCT-SPEC §5).

```js
import { analyzeInbound } from '../notifications/index.js';

// … inside ingestInbound(), after: const out = await engine.handleMessage(inbound);

const analysis = analyzeInbound({
  tenant: clinic,          // the resolved clinic/tenant (has specialties, country, handoff)
  text: inbound.text,
  lang: out.lang,
  engineResult: out,
  waId: inbound.from,
  bus,                     // emits lead.hot / emergency.detected for the service
  conversationId,          // `${tenantId}:${waId}` — already computed above
});

if (analysis.overrideReply) {
  // Emergency: replace the engine reply, alert staff, and pause the bot.
  await sendAs('bot', conversationId, () =>
    sender.sendText(clinic, inbound.from, analysis.overrideReply)
  );
  await store.conversations.update(tenantId, conversationId, {
    status: 'needs_human',
    aiPaused: true,
  });
  return { tenantId, conversationId, emergency: analysis.emergency };
}

// …otherwise fall through to the existing sendEngineReply(clinic, inbound.from, out) path.
```

Optional (nicer handoff alerts): enrich the existing `handoff.requested` publish
with `lastMessage: inbound.text, patientWaId: inbound.from`. The formatter already
degrades gracefully (shows `—`) when they're absent, and recovers `patientWaId`
from `conversationId`.

The **same three lines** go into `POST /simulate` and `/api/sandbox` so every
transport honors emergencies identically (feed the same normalized shape).

### 2. Start the service once, at composition — `src/server.js` `createApp`

After the shared `bus` / `sender` / `store` are composed, start the subscriber
and expose it so it can be stopped on shutdown:

```js
import { createNotificationService } from './notifications/index.js';

const notifier = createNotificationService({ bus, sender, store });
// return notifier alongside { app, store, bus, sender, … } and call
// notifier.stop() on SIGTERM/close (tests can await notifier.settled()).
```

`sender.sendText(tenant, ownerNumber, text)` sends the alert **from** the clinic
number **to** the owner — inside the 24h window in the pilot; P2 swaps to a
`sendTemplate` when the owner is outside their window (WhatsApp rule).

### 3. Optional cron for digests

`runDailyDigest` / `runWeeklyDigest` are pure-aggregation + send; schedule them
(node-cron, PM2 cron, or a system crontab hitting a tiny admin route):

```js
// every day 08:00 clinic-local — morning summary with the money line
for (const t of await store.tenants.list()) await notifier.runDailyDigest(t.id);
// Mondays 08:00 — weekly report
for (const t of await store.tenants.list()) await notifier.runWeeklyDigest(t.id);
```

`computeDigestStats(storeData, range)` is exported separately (pure) for the
Analytics screen (§3.4) so the dashboard and the digest share one calculation.

---

## Per-tenant configuration (all optional — safe defaults everywhere)

Read from `tenant.config` (the clinic record) and/or `notification_prefs` rows:

```jsonc
// clinics.json → clinic.notifications (or a notification_prefs row per recipient)
{
  "lang": "fr",                       // owner alert language (default fr)
  "recipients": ["21620111222"],      // default = handoff.phone if unset
  "quietHours": { "start": "22:00", "end": "07:00" },
  "emergencyNumber": "190",           // patient-facing; default per country (TN 190, LY 1515)
  "avgProcedureValue": 3000           // enables the digest money line (bookings × value)
}
```

`notification_prefs` row shape (per recipient, via `store.notificationPrefs`):
`{ recipient, channel:'whatsapp', lang?, active?, quietHours?, events:{ booking?, hotLead?, handoff?, emergency?, dailyDigest?, weeklyDigest? } }`
— any event key set to `false` disables it; omitted = on.

## Tests
- `test/notifications.detector.test.js` — emergency AR/FR/EN positives + tricky
  negatives (breast≠chest صدر, allergy without acute marker, bare "douleur"),
  hot-lead positives/negatives incl. the +218 travel case.
- `test/notifications.service.test.js` — recipients, per-event formatting,
  quiet-hours (booking suppressed, emergency not), dedupe, toggles, per-recipient
  language, throwing-sender safety, digest math + money line, pipeline overrides.
