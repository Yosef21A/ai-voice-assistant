# HANDOFF-STATE — live WhatsApp wiring as of 2026-07-20
> Snapshot for the Claude Code session taking over. Read this AFTER CLAUDE.md. This reflects REAL, live infrastructure — treat carefully.

## Live identifiers (Meta)
| Thing | Value |
|---|---|
| Meta app | `omen-clinic-agent` — app id `1525491438707612` |
| Business portfolio | `nitrox.69` (id `174044500164654`) — OmenLabz portfolio blocked by a "payment disabled" account flag; appeal pending, re-home later |
| WABA id | `1038353382027655` |
| Test number | **+1 (555) 177-7574** — phone_number_id `1153135121224452` |
| Allow-listed recipient | +216 29 496 305 (Youssef, verified via OTP) — max 5 total |
| Webhook callback | **rotates every session** — a free `trycloudflare` URL changes on every `cloudflared` restart, so it MUST be re-entered in the Meta console each time (see below). Last set 2026-07-25: `https://durham-pharmaceutical-painted-robin.trycloudflare.com/webhook` |
| Console page | developers.facebook.com → app → WhatsApp → Étape 1 (api-testing-v2) |

## .env state (repo root, git-ignored — NEVER commit or print it)
- `WHATSAPP_TOKEN` — **temporary token, expires ~24h.** When it dies (Graph returns `OAuthException 190`):
  console Étape 1 → "Générer un token" (popup; popups must be allowed) → paste new value into `.env` →
  restart the server. Youssef pastes it himself; it never needs to travel through chat.
- `WHATSAPP_PHONE_NUMBER_ID=1153135121224452`, `WHATSAPP_VERIFY_TOKEN=omen-verify-18c7b105b0484b25`, `APP_SECRET` set. `WHATSAPP_APP_SECRET` NOT set (signature check off — fine for dev).
- `GEMINI_API_KEY` + `GEMINI_MODEL` are set → `/health` reports provider `gemini` and the bot runs in
  LLM (humanize) mode. Unset the key and it runs classic/deterministic. The free tier has a DAILY quota
  that has been exhausted before — when it is, the provider degrades and the bot silently runs classic.
- `data/clinics.json`: El Amen tenant keyed to `1153135121224452` (committed `2b92c67`).

## Session start-up ritual (what actually has to happen every time)
1. `npm start` (port 3000) — kill any stale listener first: `netstat -ano | grep :3000`, confirm the PID is
   `node src/server.js`, then `taskkill //PID <pid> //F`. Stopping the shell task does NOT kill the child.
2. `cloudflared tunnel --url http://localhost:3000` → note the NEW public URL.
3. Meta console → WhatsApp → Étape 1 → Webhook → Modifier → paste `<new-url>/webhook` + the verify token
   above → Vérifier et enregistrer. Pre-check it yourself first — the handshake is just:
   `curl "<url>/webhook?hub.mode=subscribe&hub.verify_token=<verify-token>&hub.challenge=OK"` → echoes `OK`.
4. Confirm the app is still subscribed to the WABA (this silently failed once and produced NO webhooks):
   `curl -H "Authorization: Bearer $TOK" "https://graph.facebook.com/v25.0/1038353382027655/subscribed_apps"`
   → expect `omen-clinic-agent` in the list.
5. Testing without bothering the founder: WhatsApp Web in his Chrome (claude-in-chrome MCP) is logged in
   and his number is the allow-listed recipient, so messages sent from there exercise the real loop.

## THE BUG WE FIXED LAST (important)
Inbound messages produced NO webhook because the app was never subscribed to the WABA (console auto-subscribe silently failed). Fixed via API — this is the diagnostic + fix if it ever regresses:
```bash
TOK=$(grep '^WHATSAPP_TOKEN=' .env | cut -d= -f2)
# check (expect omen-clinic-agent in the list):
curl -sS -H "Authorization: Bearer $TOK" "https://graph.facebook.com/v25.0/1038353382027655/subscribed_apps"
# fix:
curl -sS -X POST -H "Authorization: Bearer $TOK" "https://graph.facebook.com/v25.0/1038353382027655/subscribed_apps"
```
Status at handoff: subscription CONFIRMED ({"success":true}); Youssef had not yet re-sent the test message. **First task: complete this verification** (see below).

## How to verify the live loop (first thing to do)
1. Run servers (see below), confirm `GET /health` 200 via the tunnel.
2. Ask Youssef to send `مرحبا نحب نحجز موعد` from his WhatsApp to +1 (555) 177-7574.
3. Watch `data/runtime/conversations.json` appear/grow (webhook arrived) and server logs for the outbound reply (Graph API 200 = reply sent). His phone gets the Arabic reply.
4. Drive the full booking to confirmation; check dashboard (localhost:3000 → login exists in data/runtime/users.json) inbox + appointments.
5. Failure modes: 401 on send = token expired (regenerate); `#131030` = recipient not allow-listed; webhook silent = re-check subscribed_apps + tunnel URL still matches the console.

## Running servers in background (Claude Code should own these)
Use background bash tasks (run_in_background) and read logs from the task output:
```bash
npm start                                   # bot + dashboard on :3000
cloudflared tunnel --url http://localhost:3000   # public tunnel
```
- If the tunnel restarts, the URL CHANGES → the Meta console webhook must be updated to the new `https://…/webhook` (verify token above) — Youssef does this in the console UI (or automate later with an app-access-token subscriptions call).
- `npm start` must be restarted whenever `.env` changes.
- Keep `npm test` green (252 pass / 1 skip baseline) before/after every change.

## Build roadmap after verification (in order)
1. **P1-G** — engine async on the store interface → `DATABASE_URL` flips Postgres to primary (schema/adapter/tests already exist from P1-A).
2. **Libyan-dialect + LLM polish** — per-tenant KB injected into the Anthropic provider prompts; tighten AR replies (Libyan colloquial), keep booking deterministic.
3. **Media handling** — inbound image/document (X-rays) → download from Graph, store, surface in inbox lead card (spec §3.1/§3.3).
4. **Reminder templates** (spec §3.7) — T-48h/T-3h confirm-button templates + submission flow.
5. **Production** — VPS deploy per `deploy/RUNBOOK.md`, real number + permanent System-User token (§E), then Postgres cutover.
Full feature spec: `PRODUCT-SPEC.md`. Pricing guardrails: `docs/pricing-and-packaging.md`. Meta onboarding detail: `docs/TESTING-WITH-REAL-WHATSAPP.md`.
