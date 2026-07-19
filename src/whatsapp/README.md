# `src/whatsapp` — Outbound WhatsApp sender (Phase 1, Slice B)

The **single outbound gateway** to the Meta WhatsApp Cloud API (Graph). Every
message the platform sends to a patient — bot replies, human-takeover typing,
owner notifications, appointment reminders — goes through this one module so
retries, rate handling, the 24h-window rules, error typing and message logging
live in exactly one place.

Inbound is still handled by `src/server.js` (`normalizeWhatsApp`); this module is
purely the send side. It is **transport-agnostic** and imports nothing from
`src/store` or `src/engine`, so it composes cleanly with the ongoing store
refactor (P1-A) and the engine.

## Quick start

```js
import { createSender } from './whatsapp/index.js';

// Offline by default (no token → mock transport, writes data/runtime/outbox.json)
const wa = createSender();

// Production: WHATSAPP_TOKEN set → real transport. Pass a persistence hook so
// every send is logged (future messages table).
const wa = createSender({ onOutbound: (record) => store.logOutbound(record) });

const tenant = store.getClinicByPhoneNumberId('1000000001'); // any tenant shape (see below)
const res = await wa.sendText(tenant, '218910000001', 'Bonjour 👋');
// → { ok: true, waMessageId: 'wamid.HBg...' }
```

`createSender()` reads configuration from the environment for anything you don't
pass explicitly, so the same call works in dev, test and prod.

## Configuration (env, read in-module, same style as `src/config.js`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `WHATSAPP_TOKEN` | `''` | Bearer token. **Absent ⇒ mock transport.** |
| `WHATSAPP_TRANSPORT` | auto | Force `mock` or `real` (auto = `real` iff a token exists). |
| `WHATSAPP_GRAPH_VERSION` | `v23.0` | Graph API version segment. |
| `WHATSAPP_API_BASE` | `https://graph.facebook.com` | Override for tests/proxies. |
| `WHATSAPP_TIMEOUT_MS` | `15000` | Per-request timeout (AbortController). |
| `WHATSAPP_MAX_RETRIES` | `3` | Retries on 429/5xx/network. |

All of the above (plus `retryBaseMs`, `retryMaxMs`, `outboxFile`, `onOutbound`,
and the injectable seams `fetchImpl` / `sleep` / `randomFn` / `now` / `logger`)
are also accepted as `createSender({...})` options; explicit options win over
env.

## API surface

Every method is `async` and returns a structured, **never-thrown** result:
`{ ok: true, waMessageId? }` or `{ ok: false, error }` (see taxonomy). The first
argument is always the `tenant` (it supplies the `phone_number_id`).

| Method | Sends |
| --- | --- |
| `sendText(tenant, toWaId, text, opts?)` | Free-form text (valid only inside the 24h window). `opts.previewUrl` toggles link previews. |
| `sendTemplate(tenant, toWaId, name, lang, components?)` | Pre-approved template — the only thing allowed **outside** the window (reminders). `lang` is a code string (`'ar'`) or `{ code }`. |
| `sendMedia(tenant, toWaId, { type, idOrLink, caption?, filename? })` | `type ∈ image·document·video·audio·sticker`. `idOrLink` auto-detects: `http(s)…` → link, else a Media ID. `caption` applies to image/video/document only. |
| `sendButtons(tenant, toWaId, bodyText, buttons)` | Interactive **reply buttons** (max 3). Each button is `{ id, title }` or a bare string (→ title, with a positional id `btn_1…3`). Titles truncated to 20 chars. |
| `markRead(tenant, waMessageId)` | Blue-tick an inbound message. Returns `{ ok }` (no id). |
| `sendEngineReply(tenant, toWaId, reply)` | Adapter — see below. |

### Tenant shapes accepted

`phone_number_id` is resolved from any of: `tenant.phone_number_id`,
`tenant.phoneNumberId`, `tenant.whatsapp.phoneNumberId`, or a bare string/number
(`'1000000001'`). A per-tenant token (`tenant.accessToken` / `tenant.token` /
`tenant.whatsapp.token`) overrides the env token when present (future BYO-token
tenants); otherwise the env `WHATSAPP_TOKEN` is used.

### `sendEngineReply(tenant, toWaId, reply)`

Bridges the **engine reply payload** (the shape `engine.handleMessage` returns
and `server.js` / `simulate.js` consume) to concrete sends, keeping callers
transport-agnostic:

- `reply` may be a plain **string**, or the engine object `{ reply, replies, … }`.
- Each entry of `replies` (falling back to the joined `reply` string) is sent as
  its own text message — matching how the simulator prints multi-bubble replies.
- If the reply **declares quick options** via `buttons` | `quickReplies` |
  `options` | `actions`, the final line is sent as interactive reply buttons
  instead of text. (The current engine emits no options yet; this is the forward
  contract for P1-D/E — add a `buttons: [{id,title}]` field to a reply and it
  just works.)
- Returns `{ ok, results:[…perSend], waMessageId? }`.

## Error taxonomy (`./errors.js`)

Failures are mapped from the Graph error **code first**, then HTTP status (Graph
often returns HTTP 400 for semantically different failures). The `error` object
in a result is a serializable projection: `{ type, code, message, status,
graphCode, graphSubcode, retriable, retryAfter }`. Classes are exported for
`instanceof` checks.

| `type` | Triggers | Retriable | Caller should |
| --- | --- | --- | --- |
| `AuthError` | HTTP 401/403; codes 0,3,10,190,200–299; missing token | no | Alert ops — token/permission is broken; do not resend. |
| `RateLimited` | HTTP 429; codes 4,80007,130429,131048,131056,133016 | **yes** | Handled internally (honors `Retry-After`); if surfaced, back off / queue. |
| `InvalidRecipient` | codes 131030, 131026 | no | Mark the number unreachable; surface in the lead card. |
| `WindowExpired` | **code 131047** (24h re-engagement) | no | **Switch to a `sendTemplate` reminder** — text is refused outside the window. |
| `TransportError` | network error, timeout, HTTP 5xx | **yes** | Auto-retried up to `maxRetries`; if still failing, it is transient — retry later. |
| `WhatsAppError` | any other 4xx (e.g. code 100 bad param) | no | Programming/payload error — fix the call. |

**Retry policy:** exponential backoff with equal jitter
(`min(retryMaxMs, base·2^n)`), a server `Retry-After` honored verbatim, capped at
`maxRetries`. Only `retriable` errors are retried; logical 4xx never are.

## Transports

- **real** — global `fetch` (Node 18+/22) to
  `{apiBase}/{graphVersion}/{phone_number_id}/messages`.
- **mock** — no network. Records every send (the exact request payload that the
  real transport would post, plus outcome metadata) to
  `data/runtime/outbox.json` and returns a fake `wamid.MOCK-…` id. This is what
  keeps `npm run simulate`, tests and local dev fully offline. `data/runtime/` is
  git-ignored.

Selected automatically: **mock unless a token is present**, or force with
`WHATSAPP_TRANSPORT` / `createSender({ transport })`.

## Persistence hook (`onOutbound`)

`createSender({ onOutbound })` fires the callback with an audit `record` for
**every** send, on **both** transports:

```js
{
  at, transport, kind,          // 'text' | 'template' | 'media' | 'buttons' | 'read'
  tenantId, phoneNumberId, to,
  payload,                      // the exact Graph request body
  ok, waMessageId, error        // outcome
}
```

The module deliberately does **not** import the store. A future slice injects a
writer here (`onOutbound: (r) => store.insertMessage(r)`); the hook is wrapped so
a throwing writer can never break a send.

## Integration notes for later slices

- **P1-C/D (live inbox + human takeover):** call `sendEngineReply(...)` for bot
  turns and `sendText(...)` for staff messages from the dashboard; pause the bot
  when a staff send occurs. `markRead(...)` on inbound to show read receipts. Pass
  `onOutbound` to persist to the `messages` table and fan out over SSE.
- **P1-E (owner notifications):** compose the notification and call `sendText` (or
  `sendTemplate` if the owner is outside their window) to the configured staff
  numbers on booking / hot-lead / handoff / emergency events.
- **P2 (reminders & campaigns):** use `sendTemplate` with confirm/cancel
  `components`; a `WindowExpired` (131047) from a text send is the signal that a
  template is required.

## Where to wire it

`src/server.js` currently has an inline `sendReply()` that hard-codes `v20.0` and
has no retries/typing. Slice C/D should replace that with
`createSender({ onOutbound }).sendEngineReply(tenant, inbound.from, out)`. Left
untouched here to avoid colliding with the concurrent store/engine work.
