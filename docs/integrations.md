# Integrations — CRM sync v1 (V7)

Omen Concierge pushes every appointment and lead event to YOUR system as a
signed webhook, and exports CSVs on demand. No vendor lock-in, no OAuth dance:
one URL + one secret.

## Outbound webhooks

Configure in **Settings → Notifications → CRM sync**: a webhook URL and a
signing secret. From then on these events POST there as JSON:

| Event | When |
|---|---|
| `appointment.created` | the bot (or staff) books an appointment |
| `appointment.updated` | status changes (confirmed/done/no_show/cancelled…) |
| `appointment.cancelled` | the patient cancels via a reminder button |
| `lead.hot` | a high-value / qualified lead is detected |
| `lead.updated` | staff moves a lead on the pipeline board |

Body shape:

```json
{
  "event": "appointment.created",
  "tenantId": "el-amen-sousse",
  "at": "2026-07-30T09:00:00.000Z",
  "data": { "ref": "EAS-260730-001", "status": "confirmed", "specialty": "dental", "...": "..." }
}
```

Every request carries:

- `X-Omen-Event`: the event name
- `X-Omen-Signature`: `sha256=<hex>` — HMAC-SHA256 of the **exact raw body**
  with your secret. Verify before trusting:

```js
const crypto = require('crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-omen-signature'] || ''));
```

Delivery: 10s timeout, 3 attempts with backoff on network errors/5xx (a 4xx is
not retried — fix the receiver). Every attempt's outcome is recorded in the
tenant audit log (`crm.delivery`).

## 10-minute Google Sheets recipe (no OAuth in-product — honest v1)

1. Open a new Google Sheet → **Extensions → Apps Script**, paste:

```js
const SECRET = 'paste-the-same-secret-here';

function doPost(e) {
  const body = e.postData.contents;
  const sig = 'sha256=' + Utilities.computeHmacSha256Signature(body, SECRET)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  // (Apps Script doesn't expose request headers to doPost — the secret check
  // here is a shared-knowledge check on a query param instead:)
  if (e.parameter.key !== SECRET) return ContentService.createTextOutput('forbidden');

  const evt = JSON.parse(body);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    evt.event.startsWith('lead') ? 'Leads' : 'Appointments'
  ) || SpreadsheetApp.getActiveSpreadsheet().insertSheet(
    evt.event.startsWith('lead') ? 'Leads' : 'Appointments'
  );
  sheet.appendRow([evt.at, evt.event, JSON.stringify(evt.data)]);
  return ContentService.createTextOutput('ok');
}
```

2. **Deploy → New deployment → Web app** — execute as *Me*, access *Anyone*.
   Copy the `/exec` URL.
3. In Omen **Settings → CRM sync**, paste the URL **with the key appended**:
   `https://script.google.com/.../exec?key=YOUR-SECRET` and the same secret in
   the secret field.
4. Book a test appointment in the sandbox — a row appears in the Sheet.

> Apps Script can't read the signature header, hence the query-string key.
> A real CRM endpoint (n8n, Make, Zapier webhook, your backend) should verify
> `X-Omen-Signature` properly as shown above.

## CSV export

**Settings → Notifications → CSV export**, or directly (owner session):

```
GET /api/export/appointments.csv?from=2026-07-01&to=2026-08-01
GET /api/export/leads.csv
```

UTF-8 with BOM — Excel opens Arabic text correctly. Patient data belongs to
the clinic: these exports are the concrete promise.
