# Testing the bot with REAL WhatsApp — using Meta's free test number
### Your personal WhatsApp stays untouched. No second SIM needed for testing.

## How this works (read first)
- Bots do NOT run on web.whatsapp.com / the normal app. They run on the **WhatsApp Cloud API** — a separate Meta system where a phone number is registered to an app instead of a phone.
- **Never register your personal number on the Cloud API** — a number on the API stops working as a normal WhatsApp account.
- Meta provides every developer app a **free TEST NUMBER**: the bot answers *from* it, and you message it *from your own WhatsApp* like a patient would. Your account only *sends* messages to the bot — it never replies on your behalf, and conversations with real people are completely unaffected.
- Limits of the test number: you can only message up to **5 verified recipient numbers**, and the temporary token expires every ~24h. Perfect for testing; production uses a real dedicated number later (see `deploy/RUNBOOK.md` §E).

---

## Step 1 — Create the Meta app + get the test number (~10 min)
1. Go to **developers.facebook.com** → log in with your Facebook account → *My Apps* → **Create App** → type **Business** → name it (e.g. `omen-clinic-agent-dev`).
2. In the app dashboard: **Add product → WhatsApp → Set up**. (It may ask to create/link a Meta Business portfolio — accept the default.)
3. Open **WhatsApp → API Setup**. You'll see:
   - **Test number** (e.g. +1 555 …) — the bot's number
   - **Phone number ID** — copy it (this is `WHATSAPP_PHONE_NUMBER_ID`)
   - **Temporary access token** — copy it (this is `WHATSAPP_TOKEN`, expires ~24h — regenerate when it dies)
4. Under **To** on that same page: add YOUR personal WhatsApp number as a recipient → Meta sends you a code on WhatsApp → enter it. (You can add up to 5 numbers — add your second phone / a friend for demo purposes too.)
5. Optional sanity check: use the page's *Send message* button — you should receive Meta's "hello world" template on your WhatsApp.

## Step 2 — Point a tenant at the test number
The webhook routes messages to a tenant by `phone_number_id`. Edit `data/clinics.json` and set the first clinic's `phone_number_id` to the **Phone number ID** you copied:
```json
"phone_number_id": "PASTE_THE_ID_HERE"
```
Restart the server after editing.

## Step 3 — Configure .env
Create/edit `.env` in the repo root:
```
PORT=3000
WHATSAPP_TOKEN=EAAG...            # temporary token from API Setup
WHATSAPP_PHONE_NUMBER_ID=1234567890   # test number's ID
WHATSAPP_VERIFY_TOKEN=omen-dev-verify # any string YOU invent; used in Step 5
# WHATSAPP_APP_SECRET=...         # optional now; enables signature checks
# WHATSAPP_TRANSPORT=mock         # make sure this is NOT set — we want real sends
```

## Step 4 — Expose localhost with a tunnel
Meta must reach your webhook over public HTTPS. Easiest (no signup):
```
npm start                                   # terminal 1 — bot on :3000
cloudflared tunnel --url http://localhost:3000   # terminal 2
```
(Install once: `winget install Cloudflare.cloudflared` — or use ngrok if you prefer: `ngrok http 3000`.)
Copy the public `https://….trycloudflare.com` URL it prints. Note: this URL changes each run — repeat Step 5 when it does.

## Step 5 — Register the webhook
In the app dashboard: **WhatsApp → Configuration → Webhook → Edit**:
- **Callback URL:** `https://<your-tunnel>/webhook`
- **Verify token:** exactly your `WHATSAPP_VERIFY_TOKEN` value
- Click *Verify and save* — your running server answers the challenge automatically.
- Then under **Webhook fields**: **Subscribe to `messages`**. (Only `messages` is needed.)

## Step 6 — Talk to your bot 🎉
From YOUR WhatsApp, message the test number:
- `مرحبا نحب نحجز موعد` → Arabic booking flow
- `Bonjour, je veux un rendez-vous` → French flow
Complete a booking, then open the dashboard (`http://localhost:3000`) → the conversation is in the **Inbox**, the booking in **Appointments**, and takeover/staff-reply works on the live thread.

---

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Webhook verify fails | Server not running, tunnel URL stale, or verify token mismatch (.env vs console). |
| Message sent, no reply | Token expired (24h) → regenerate in API Setup; or tenant `phone_number_id` doesn't match; check server logs. |
| `(#131030)` recipient not allowed | Your number isn't in the 5-recipient allow-list (Step 1.4). |
| Reply arrives but no dashboard update | You edited clinics.json without restarting; or you're logged into a different tenant. |
| 401/403 from Graph | Token pasted with spaces/truncated, or expired. |
| Bot answers slowly | Free tunnels add latency; production on the VPS is faster. |

## When you're ready for production
Follow `deploy/RUNBOOK.md` §E: dedicated number (a fresh SIM — the number must NOT be active on consumer WhatsApp), permanent System-User token (no 24h expiry), business verification, and the VPS webhook behind Nginx+TLS instead of a tunnel.
