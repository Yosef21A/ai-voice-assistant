# `src/store` — storage adapter layer

The engine and (from Phase 1 on) the dashboard/API talk to storage through a
small **adapter interface**. Two adapters implement it:

| adapter    | module                          | when            | notes                                   |
|------------|----------------------------------|-----------------|-----------------------------------------|
| `json`     | `adapters/json/index.js`         | **default**     | file-backed, zero-config, single-process |
| `postgres` | `adapters/postgres/index.js`     | opts / prod     | `pg` pool, multi-process, tenant-scoped  |

```js
import { createStore } from './src/store/index.js';

// JSON (default, offline) — used by the engine, simulator and existing tests:
const store = createStore({ clinicsFile, runtimeDir, reset: true });

// Postgres — used by the migrate/seed scripts and the API layer (P1-C):
const store = createStore({ store: 'postgres', databaseUrl: process.env.DATABASE_URL });
```

## Selection rules (important)

`createStore(opts)` selects the adapter from **explicit `opts` only**:

```
kind = opts.store || (opts.databaseUrl ? 'postgres' : 'json')
```

It **does not read `process.env`**. This is deliberate: the conversation engine
still calls the store **synchronously**, so ambient `DATABASE_URL` must never
silently flip `server.js`/`simulate.js`/the test suite onto the async Postgres
adapter. `src/config.js` surfaces the env (`config.databaseUrl`, `config.store`);
the composition layer decides when to pass them in. `createStore()` returns
synchronously for both adapters (the Postgres pool connects lazily; `pg` is
`require`d lazily so JSON-only runs never load it).

## Two surfaces

### 1. Legacy synchronous surface (JSON adapter only)
Preserved byte-for-byte for the existing engine + tests — **do not change**:

```
listClinics()  getClinicById(id)  getClinicByPhoneNumberId(pnid)  getDefaultClinic()
upsertPatient(clinicId, waId, patch)
getConversation(clinicId, waId)  newConversation(clinicId, waId)  saveConversation(convo)
createAppointment(appt)  listAppointments(filter)
```

The engine (`src/engine/`) uses only this surface. Migrating the request path to
the async interface below (so it can run on Postgres) is P1-C.

### 2. Async collection interface (both adapters)
Every method returns a `Promise`. Every tenant-owned method takes `tenantId`
(the clinic slug) as its first argument and is **scoped to it** — tenant A can
never read or mutate tenant B's rows through this API.

```
store.name                       'json' | 'postgres'
store.health() -> {ok, adapter}
store.close()                    release pool / resources

tenants.getByPhoneNumberId(pnid) .getById(id) .list() .upsert({id, phoneNumberId, name, city,
                                 country, timezone, currency, languages[], config{}})
patients.upsert(tenantId, waId, patch) .get(tenantId, waId) .list(tenantId)
conversations.get(tenantId, waId) .getById(tenantId, id)
             .create(tenantId, {patientWaId, lang, status, aiPaused, state})
             .list(tenantId, {status, aiPaused})
             .update(tenantId, id, {status, aiPaused, lang, state, lastMessageAt})
             .setStatus(tenantId, id, status) .setAiPaused(tenantId, id, bool)
             .appendMessage(tenantId, convId, {direction, type, body, waMessageId, status, ts})
             .listMessages(tenantId, convId, {limit})      // chronological (ts, seq)
appointments.create(tenantId, data) .list(tenantId, {status, patientWaId, from, to})
            .get(tenantId, id) .updateStatus(tenantId, id, status)
leads.create(tenantId, data) .list(tenantId, {status}) .get(tenantId, id)
     .updateStatus(tenantId, id, status)
kbEntries.list(tenantId, {status}) .get(tenantId, key) .upsert(tenantId, entry)
         .remove(tenantId, key)      // soft: status -> 'archived'
events.append(tenantId, {type, actor, conversationId, payload})   // append-only audit
      .list(tenantId, {type, limit})                              // insertion order (asc)
notificationPrefs.list(tenantId) .get(tenantId, recipient, channel)
                 .upsert(tenantId, pref) .remove(tenantId, recipient, channel)
```

### Conventions
- **Field names** are `camelCase` on the way in and out. The Postgres adapter
  maps snake_case columns automatically (`phone_number_id` ⇄ `phoneNumberId`,
  `datetime_iso` ⇄ `datetimeIso`, `wa_message_id` ⇄ `waMessageId`).
- **Types:** Postgres returns `timestamptz` as JS `Date` and `jsonb` as parsed
  objects/arrays; the JSON adapter stores/returns ISO strings and plain objects.
  Treat timestamps as opaque and compare via `new Date(x).getTime()` if needed.
- **`tenants`** is the registry and is not itself tenant-scoped. For JSON it is
  seeded read-only from `data/clinics.json`, overlaid by runtime `upsert`s.
- **Idempotency:** `tenants.upsert`, `patients.upsert`, `conversations.create`,
  `kbEntries.upsert`, `notificationPrefs.upsert` all upsert on their natural key.

## Schema & operations (Postgres)
- Canonical schema: `sql/001_init.sql` (tables: `tenants`, `users`, `patients`,
  `conversations`, `messages`, `appointments`, `leads`, `kb_entries`, `events`,
  `notification_prefs`; migrations tracked in `schema_migrations`).
- Apply: `npm run db:migrate`   Seed tenants + KB from clinics.json: `npm run db:seed`
  (both read `DATABASE_URL`).
- One conversation per `(tenant_id, patient_wa_id)`; `messages` is the normalized
  transcript (the JSON adapter keeps a parallel `messages` collection so both
  adapters expose the same `appendMessage`/`listMessages` contract).

## Adding an adapter
Implement the async interface above (name, health, close, and the eight
collections), export a `create<Kind>Store(opts)` factory, and wire it into
`resolveKind`/`createStore` in `index.js`. Keep every query tenant-scoped and
parameterized. Test parity by pointing a suite like
`test/store.postgres.test.js` at it.
