# omen-clinic-agent — Production Deploy & Meta WhatsApp Runbook

Operator runbook for taking **omen-clinic-agent** live on a single Ubuntu VPS
behind Nginx + TLS, under PM2, wired to the **Meta WhatsApp Cloud API**. Every
step is copy-paste and shows the **expected output** so you know it worked.

> Ground truth this kit is built against (verified from `src/config.js`,
> `src/server.js`, `src/store/index.js`):
> - Express binds **`PORT` (default 3000)**, localhost-only behind Nginx.
> - Routes: `GET /webhook` (Meta verify), `POST /webhook` (inbound),
>   `POST /simulate` (LOCAL test only — never proxied), `GET /health`.
> - Env vars (all read in `config.js`): `PORT`, `WHATSAPP_TOKEN`,
>   `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
>   `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. No others exist — do not invent any.
> - PM2 app name: **`omen-clinic-agent`**. App dir: **`/opt/omen-clinic-agent`**.
> - Store is **JSON files** in `data/runtime/{patients,conversations,appointments}.json`
>   → **single instance only** (see §G). `.env` and `data/runtime/` are git-ignored.
> - `POST /webhook` enforces the `X-Hub-Signature-256` HMAC **only when
>   `WHATSAPP_APP_SECRET` is set** — so setting it is mandatory in prod (§F).

## Conventions
- `deploy@vps $` = run as the **non-root deploy user**. `root #` = run as root
  (or prefix with `sudo`). Replace **`agent.clinic.com`** with the real clinic
  subdomain and **`YOUR.VPS.IP`** with the server's public IPv4 everywhere.
- The repo lives at `/opt/omen-clinic-agent`; all `deploy/*` paths are relative
  to it. Run `deploy.sh` and PM2 commands **from that directory**.

## Section map
- §A VPS prep (OS, deploy user, Node LTS, firewall, fail2ban)
- §B App deploy (clone, deps, `.env`, data ownership)
- §C PM2 (start, boot-persist, logs, log rotation)
- §D Nginx + TLS (reverse proxy, Let's Encrypt, renewal)
- §E **Meta WhatsApp Cloud API onboarding** (the critical path)
- §F Go-live checklist (end-to-end test, signature, backups, rollback, digest crons)
- §G Multi-tenant onboarding & scaling limits
- §H Dashboard onboarding (first-owner setup + the onboarding wizard)

---

## §A — VPS preparation

Target: **Ubuntu 22.04 LTS or 24.04 LTS**, x86_64, 1 vCPU / 1 GB RAM is enough
for many clinics (the app idles at ~40-70 MB RSS).

### A1. Create the server and log in as root
Provision the droplet/instance, point DNS (see §D1), then:
```bash
ssh root@YOUR.VPS.IP
```

### A2. Patch the base system
```bash
apt-get update && apt-get -y upgrade
```
Expected: apt finishes with `0 upgraded` on a re-run. Reboot if a kernel
updated: `reboot` (then reconnect).

### A3. Create the non-root deploy user (never run the app as root)
```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```
Verify from a NEW terminal (keep the root session open as a lifeline):
```bash
ssh deploy@YOUR.VPS.IP 'id'
```
Expected: `uid=1000(deploy) gid=1000(deploy) groups=1000(deploy),27(sudo)`.

### A4. Install Node.js LTS from NodeSource (app requires Node >= 18; use LTS 20/22)
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
```
Expected: `v22.x.x` and an npm `10.x`/`11.x` line. (Ubuntu's own `nodejs`
package is too old — always use NodeSource.)

### A5. Firewall — allow only SSH + HTTP + HTTPS (never expose port 3000)
```bash
sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp     # SSH  (before enabling, or you lock yourself out)
sudo ufw allow 80/tcp     # HTTP  (ACME challenge + redirect)
sudo ufw allow 443/tcp    # HTTPS (Meta webhook — the only app surface)
sudo ufw --force enable
sudo ufw status verbose
```
Expected: `Status: active` and rules listing 22, 80, 443 as `ALLOW IN`.
Port **3000 is deliberately absent** — the app is reachable only via Nginx on
localhost. Confirm later with: `sudo ss -ltnp | grep 3000` → bound to
`127.0.0.1:3000`, not `0.0.0.0`.

### A6. fail2ban — throttle SSH brute-force
```bash
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```
Expected: a `Status for the jail: sshd` block with `Currently banned` counts.
The default `sshd` jail is on out of the box; no config needed for a baseline.
(Optional hardening: set `PasswordAuthentication no` and
`PermitRootLogin prohibit-password` in `/etc/ssh/sshd_config`, then
`sudo systemctl reload ssh`.)

---

## §B — Application deploy

Run everything below as **deploy** (`ssh deploy@YOUR.VPS.IP`).

### B1. Create the app directory owned by deploy
```bash
sudo install -d -o deploy -g deploy /opt/omen-clinic-agent
```
Expected: no output. Verify: `ls -ld /opt/omen-clinic-agent` → owner `deploy`.

### B2. Get the code into /opt/omen-clinic-agent
```bash
git clone <YOUR_REPO_URL> /opt/omen-clinic-agent
cd /opt/omen-clinic-agent
git rev-parse --short HEAD
```
Expected: a short commit SHA (e.g. `a1b2c3d`). If you deploy from a tarball
instead of git, unpack it here — but note `deploy/deploy.sh` uses
`git fetch/reset`, so a git checkout is strongly preferred.

### B3. Install dependencies + build the dashboard
Runtime deps are `express` + `pg`. The dashboard SPA (`web/`) is compiled by the
dev-only Vite toolchain into `web/dist` (git-ignored → built on the box), after
which the dev deps are pruned so the running process stays lean:
```bash
npm ci                     # full install (includes the Vite build toolchain)
npm run web:build          # emit web/dist — the dashboard Express serves at /
npm prune --omit=dev       # drop the build toolchain — runtime deps only
```
Expected: `web:build` prints the bundled asset sizes then `✓ built`. **`deploy.sh`
runs these three steps for you on every deploy** — do them by hand only for a
first manual bring-up. `npm ci` needs `package-lock.json` (present) and installs
exactly what it pins. If you skip the build, the server still boots but `/`
returns a "Dashboard not built yet" notice until `web/dist` exists.

### B4. Create the runtime data + logs directories
```bash
mkdir -p data/runtime logs
```
Expected: no output. `data/runtime/` holds the JSON store
(`patients.json`, `conversations.json`, `appointments.json`); `logs/` holds PM2
output (§C). Both are git-ignored, so they must exist on the box.
The seed `data/clinics.json` ships in the repo (read-only tenant config).

### B5. Create the production .env from the template (chmod 600 — it holds secrets)
```bash
cp deploy/.env.production.example .env
chmod 600 .env
```
Now edit `.env` and fill the values you will collect in §E. Minimum for a real
go-live (leave `ANTHROPIC_*` blank to stay on the zero-cost mock LLM):
```bash
nano .env
```
```
PORT=3000
WHATSAPP_TOKEN=<permanent System-User token from §E7>
WHATSAPP_VERIFY_TOKEN=<the value from `openssl rand -hex 24`, also typed in §E8>
WHATSAPP_PHONE_NUMBER_ID=<real phone_number_id from §E4/§E5, NOT the display #>
WHATSAPP_APP_SECRET=<App secret from §E, App settings → Basic>
APP_SECRET=<a SECOND `openssl rand -hex 24` — signs dashboard login cookies>
```
**`APP_SECRET` vs `WHATSAPP_APP_SECRET`** — two different secrets: `APP_SECRET`
signs the dashboard's session cookies (`src/auth`); `WHATSAPP_APP_SECRET` verifies
Meta's inbound webhook HMAC. `config.js` falls back to an INSECURE dev value for
`APP_SECRET`, so setting a strong one is mandatory in prod (else every session
cookie is forgeable). Generate a strong verify token now and paste the SAME value
here and into Meta:
```bash
openssl rand -hex 24
```
Expected: a 48-char hex string. Guard rails: `config.js` falls back to the dev
values `omen-verify-dev` / phone id `1000000001` if these are blank — those are
DEV ONLY; `deploy.sh` will warn if it sees the dev verify token or an empty
`WHATSAPP_APP_SECRET`.

### B6. Verify the file is locked down
```bash
ls -l .env
```
Expected: `-rw------- 1 deploy deploy ... .env` (mode 600, owner deploy). If it
shows `-rw-r--r--`, re-run `chmod 600 .env`. Never commit `.env` (it is in
`.gitignore`).

### B7. Fix ownership of the whole tree (in case any step used sudo)
```bash
sudo chown -R deploy:deploy /opt/omen-clinic-agent
```
Expected: no output. The **deploy** user must own `data/` and `logs/` so the
Node process (run by PM2 as deploy) can write the JSON store and logs. A common
failure is a root-owned `data/runtime/` → the app crashes on first
`writeFileSync` with `EACCES`.

### B8. Smoke-test the app locally BEFORE PM2/Nginx (Ctrl-C to stop)
```bash
node --check src/server.js && echo "syntax ok"
node src/server.js &
sleep 1
curl -s localhost:3000/health
kill %1
```
Expected: `syntax ok`, a startup log line
`omen-clinic-agent listening on http://localhost:3000`, then a JSON health body
like `{"ok":true,"provider":"mock","clinics":[{"id":"el-amen-sousse",...}]}`.
`provider` is `mock` unless `ANTHROPIC_API_KEY` is set. If you see the two seed
clinics, the store loaded correctly.

---

## §C — PM2 process manager

PM2 keeps the app alive, restarts it on crash, and brings it back after reboot.
The shipped `deploy/ecosystem.config.cjs` pins **fork mode, 1 instance** (a hard
constraint — see §G) and sets `cwd: /opt/omen-clinic-agent`, log paths, and
`env_production` (`NODE_ENV=production`, `PORT=3000`).

### C1. Install PM2 globally
```bash
sudo npm install -g pm2
pm2 --version
```
Expected: a version like `5.x.x` / `6.x.x`.

### C2. Start the app via the ecosystem file (from the app dir)
```bash
cd /opt/omen-clinic-agent
pm2 start deploy/ecosystem.config.cjs --env production
```
Expected: a PM2 table with one row: `name omen-clinic-agent`, `mode fork`,
`status online`, `↺ 0` (zero restarts). If `status` is `errored`, jump to logs
(C5) — the usual cause is a missing `.env` or a root-owned `data/`.

### C3. Confirm it is actually serving
```bash
pm2 status
curl -s localhost:3000/health
```
Expected: `online` and the same `{"ok":true,...}` JSON as §B8. From here on,
use **`deploy/deploy.sh`** for updates — it does `git reset`, `npm ci`,
`node --check`, `pm2 startOrReload`, then polls `/health` and auto-tells you the
rollback command.

### C4. Persist across reboots (systemd integration)
```bash
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy
```
The `pm2 startup` command PRINTS a `sudo env PATH=... pm2 startup systemd ...`
line. **Copy that exact line and run it** (it installs the systemd unit
`pm2-deploy.service`). Then re-save:
```bash
pm2 save
```
Verify the unit is enabled:
```bash
systemctl is-enabled pm2-deploy
```
Expected: `enabled`. Reboot-test when convenient: `sudo reboot`, reconnect,
`pm2 status` → the app is `online` again without any manual start.

### C5. Logs
```bash
pm2 logs omen-clinic-agent --lines 50          # live tail (Ctrl-C to exit)
pm2 logs omen-clinic-agent --lines 50 --nostream   # dump and return
```
On-disk (paths from the ecosystem file, owned by deploy):
```bash
tail -f /opt/omen-clinic-agent/logs/omen-clinic-agent.out.log
tail -f /opt/omen-clinic-agent/logs/omen-clinic-agent.err.log
```
Expected: startup banner in `.out.log`; inbound webhook processing errors (if
any) in `.err.log`. Every line is timestamped (`time:true` in the ecosystem).

### C6. Log rotation (pm2-logrotate — prevents the disk filling)
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```
Expected: each `set` prints a confirmation line. This caps each log at 10 MB,
keeps 14 compressed rotations, and also rotates daily at midnight. Verify:
```bash
pm2 conf pm2-logrotate
```
Expected: the four values above echoed back under `module.pm2-logrotate`.

---

## §D — Nginx reverse proxy + TLS

Meta **requires a public HTTPS webhook with a valid CA certificate** (no
self-signed). Nginx terminates TLS on :443 and reverse-proxies **only**
`/webhook` and `/health` to `127.0.0.1:3000`. Everything else returns `444`.
`/simulate` is intentionally NOT proxied — it stays a localhost-only test hook.

**Why webhook-only proxying:** the public attack surface is exactly one POST
route. The shipped conf preserves the **raw request body** (`proxy_request_buffering
on`, no rewrites) because `server.js` verifies Meta's `X-Hub-Signature-256` HMAC
over the raw bytes — any body mutation would break signature verification. It
also rate-limits `/webhook` (10 r/s, burst 30 nodelay) to absorb Meta's bursts
while starving scanners, and sends `444` for all other paths.

### D1. DNS — point the clinic subdomain at the VPS (do this first; propagation takes time)
Create an **A record**: `agent.clinic.com → YOUR.VPS.IP`. Verify:
```bash
dig +short agent.clinic.com
```
Expected: `YOUR.VPS.IP`. Do not proceed to D4 until this resolves — Let's
Encrypt validates over the public domain.

### D2. Install Nginx + Certbot
```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot
```
Expected: services install; `nginx -v` prints a version. The stock welcome page
now answers on `http://YOUR.VPS.IP`.

### D3. Install the provided site config and set the real domain
```bash
sudo cp /opt/omen-clinic-agent/deploy/nginx/omen-clinic-agent.conf \
        /etc/nginx/sites-available/omen-clinic-agent.conf
sudo sed -i 's/agent\.example\.com/agent.clinic.com/g' \
        /etc/nginx/sites-available/omen-clinic-agent.conf
sudo ln -sf ../sites-available/omen-clinic-agent.conf \
        /etc/nginx/sites-enabled/omen-clinic-agent.conf
sudo rm -f /etc/nginx/sites-enabled/default
```
Expected: no output. The conf's `upstream` → `127.0.0.1:3000` matches the app;
the three `agent.clinic.com` occurrences (2× `server_name`, 2× cert path) are
now set. **Do not run `nginx -t` yet** — the `ssl_certificate` paths don't exist
until D4, so the test would fail. Get the cert first.

### D4. Obtain the TLS certificate (standalone — avoids the cert/config chicken-and-egg)
The shipped conf's :443 block references certs that don't exist yet, so issue
them with certbot's own temporary server while Nginx is momentarily stopped:
```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d agent.clinic.com \
     --non-interactive --agree-tos -m ops@omenlabz.com
sudo systemctl start nginx
```
Expected: `Successfully received certificate.` and paths under
`/etc/letsencrypt/live/agent.clinic.com/fullchain.pem` + `privkey.pem` — exactly
what the conf points at. (`--nginx` is an alternative but it REWRITES the server
block; this hardened conf ships its own TLS settings, so prefer `certonly` and
keep the conf authoritative.)

### D5. Validate and load the config
```bash
sudo nginx -t
sudo systemctl reload nginx
```
Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`.
If `nginx -t` complains about a missing cert file, D4 didn't produce it for this
exact domain — re-check `dig` and the `-d` value.

### D6. Verify end-to-end over HTTPS
```bash
curl -s https://agent.clinic.com/health
curl -s -o /dev/null -w '%{http_code}\n' https://agent.clinic.com/simulate   # POSTless
curl -s -o /dev/null -w '%{http_code}\n' https://agent.clinic.com/random
```
Expected: the `/health` JSON `{"ok":true,...}`; the last line for `/random` is
`000`/closed (Nginx `444`, connection dropped — no body). TLS should be grade-A;
optionally check `https://www.ssllabs.com/ssltest/`.

### D7. Auto-renewal (switch renewal to webroot so it never needs downtime)
Standalone needs port 80 free, which conflicts with running Nginx at renewal.
Point renewal at the webroot the conf already serves
(`/.well-known/acme-challenge/` → `/var/www/certbot`):
```bash
sudo sed -i 's|^authenticator = standalone|authenticator = webroot|' \
     /etc/letsencrypt/renewal/agent.clinic.com.conf
sudo bash -c 'grep -q webroot_path /etc/letsencrypt/renewal/agent.clinic.com.conf \
     || echo "webroot_path = /var/www/certbot" >> /etc/letsencrypt/renewal/agent.clinic.com.conf'
sudo certbot renew --dry-run
```
Expected: `Congratulations, all simulations of the renewals succeeded`. The
`certbot.timer` systemd unit runs renewal twice daily; confirm with
`systemctl list-timers | grep certbot`. Add a reload hook so Nginx picks up the
new cert automatically:
```bash
echo 'deploy_hook = systemctl reload nginx' | \
  sudo tee -a /etc/letsencrypt/renewal/agent.clinic.com.conf
```

---

## §E — Meta WhatsApp Cloud API onboarding (the critical path)

This is where go-lives slip. The portal wording drifts, but the 2026 flow is:
**Business Portfolio → verify the business → create a developer App → add
WhatsApp → prove a number → mint a permanent token → wire the webhook → go
Live.** Budget **2-5 business days** because three steps are async reviews
(business verification, display-name review, template approval). Start them on
day one. You need an admin on the clinic's Meta Business Portfolio and access to
a phone number the clinic controls.

### E1. Create / open the Business Portfolio
Go to **business.facebook.com** → your Business Portfolio (formerly "Business
Manager"). If the clinic has none, create one: **Settings → Business portfolio →
Create**. Enter the **legal** business name (must match official docs — see E2),
country **Tunisia**, and a business email you can receive mail on.
Expected: a portfolio with a numeric **Business ID** (Settings → Business info).

### E2. Business verification (async — start it NOW; Tunisia notes)
**Settings → Business verification** (a.k.a. Security Center). Submit:
- **Legal business name + address + phone** exactly as on the official record.
- A **government document** proving the entity: Tunisian **RNE extract**
  (Registre National des Entreprises) / **patente**, or the **matricule fiscal**
  certificate. Documents in **Arabic or French are accepted**.
- **Proof of address** if asked: a utility bill, bank statement, or the RNE
  extract showing the same address.
- **Verify the phone** via the code Meta calls/texts, and **verify the domain**
  (`clinic.com`) if prompted (add the meta-tag / DNS TXT they give you).
Tunisia gotchas: the **name on every document must be byte-identical** to what
you typed (accents, "SARL"/"SUARL" suffix, Latin vs Arabic spelling) — a
mismatch is the #1 rejection and restarts the 1-2 business-day review. Use a
`+216` landline/mobile the clinic actually answers.
Expected: status moves `Not verified → Pending → Verified`. You can keep
building on the **test number** while this is pending, but you cannot scale
messaging tiers or add production numbers until it is **Verified**.

### E3. Create the developer App (type: Business)
Go to **developers.facebook.com → My Apps → Create App**. Choose use-case
**Other → Business**, name it (e.g. `omen-clinic-agent`), and attach it to the
**Business Portfolio** from E1.
Expected: an app dashboard with an **App ID**. Note **App settings → Basic →
App secret** (click *Show*) — this becomes `WHATSAPP_APP_SECRET` in `.env`.

### E4. Add the WhatsApp product + use the test number to prove the pipe
On the app dashboard: **Add product → WhatsApp → Set up**. Meta provisions a
**free test number** and a temporary 24-hour token.
- Under **API Setup**, copy the test number's **Phone number ID** (this is the
  `phone_number_id`, **NOT** the human display number) and add up to 5
  **recipient** numbers (your own phone) to the allow-list.
- Send the sample `curl` from that screen (or set `WHATSAPP_PHONE_NUMBER_ID` +
  the temp token in `.env` and use `/simulate` locally) to confirm plumbing.
Expected: a `messages` object with a `wamid...` id in the response, and the
WhatsApp message actually arrives on your allow-listed phone. This proves the
Cloud API path before you touch the clinic's real number.

### E5. Register the clinic's REAL number (the step that most often costs a day)
**API Setup → "Add phone number"** (or **WhatsApp Manager → Phone numbers**).
- The number **must NOT be active on the consumer WhatsApp app or the WhatsApp
  Business (SMB) app**. If it is, **delete that WhatsApp account first**
  (in the app: Settings → Account → Delete my account) and wait a few minutes.
  Cloud API will refuse a number already tied to a WhatsApp account.
- Set the **display name** (the clinic's real, recognizable name) — this goes to
  a **name review** (async, minutes to a day; must follow WhatsApp display-name
  rules, no URLs/promos).
- **Verify ownership** via **SMS or voice call** to that number, enter the code.
- Grab the new number's **Phone number ID** → this is the production
  `WHATSAPP_PHONE_NUMBER_ID` for this clinic, and it must also be set as
  `whatsapp.phoneNumberId` for the tenant in `data/clinics.json` (§G).
Expected: the number shows **Connected**, display name **Approved** (or Pending),
and a quality-rating field. Tip: use a fresh SIM or a landline that can receive
the voice code — a number the clinic uses daily on WhatsApp means real downtime
to deregister, so plan it with them.

### E6. Add the number to a WhatsApp Business Account (WABA)
When you add the product/number, Meta creates a **WABA** under the portfolio (or
pick an existing one). Note the **WABA ID** (WhatsApp Manager → account
settings). The System User in E7 must have access to **this WABA** and to the
**App**, or the token you mint can't send for this number.

### E7. Create a System User + PERMANENT access token (the token that goes in .env)
The temporary token from E4 dies in 24 h — production needs a permanent one.
**business.facebook.com → Settings → Users → System users → Add**:
- Create a **System user** (role: Admin, or Employee with asset access), name it
  e.g. `omen-agent-bot`.
- **Assign assets**: give it the **App** (from E3) and the **WABA** (from E6)
  with full control. (Skipping this is why a fresh token returns `190`/`(#10)`
  permission errors.)
- Click **Generate new token** → select the **App** → tick scopes:
  - **`whatsapp_business_messaging`** (send/receive messages)
  - **`whatsapp_business_management`** (manage numbers/templates)
- Set expiry **Never**. **Copy the token once — it is never shown again.**
Put it in `.env` as `WHATSAPP_TOKEN`. Sanity-check it can see the number:
```bash
curl -s "https://graph.facebook.com/v20.0/<PHONE_NUMBER_ID>" \
  -H "Authorization: Bearer <WHATSAPP_TOKEN>"
```
Expected: JSON with the number's `verified_name`, `display_phone_number`,
`quality_rating` — **not** an `error`. (`server.js` calls the Graph API at
`v20.0`; keep that version.)

### E8. Wire the webhook (App → WhatsApp → Configuration)
The endpoint must be **live over HTTPS first** (§D done), because Meta calls
`GET /webhook` synchronously to verify.
- **Callback URL:** `https://agent.clinic.com/webhook`
- **Verify token:** paste the **exact** string from your `.env`
  `WHATSAPP_VERIFY_TOKEN` (the `openssl rand -hex 24` value) — **byte-identical**,
  no trailing spaces. `server.js` echoes `hub.challenge` only when it matches.
- Click **Verify and save**.
Expected: green **"Verified"**. If it fails: cert not valid yet (re-check §D6),
a token mismatch, or PM2 not `online`. Test the handshake yourself:
```bash
curl -s "https://agent.clinic.com/webhook?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=ping"
```
Expected: prints `ping` (echoes the challenge). A `403` = token mismatch.

### E9. Subscribe to the `messages` field
Still on **Configuration → Webhook fields**, click **Manage** and **subscribe to
`messages`** (inbound user messages + statuses). This is the only field the app
consumes (`normalizeWhatsApp` reads `entry[].changes[].value.messages`).
Also ensure the **WABA is subscribed to the app** (WhatsApp Manager shows the
app under the account's subscribed apps).
Expected: `messages` shows a checkmark. Now message the clinic number from a
different phone → it should hit `POST /webhook`; watch it with
`pm2 logs omen-clinic-agent`.

### E10. Switch the App to Live mode
App dashboard top bar: flip **App mode** from **Development** to **Live** (fill
Privacy Policy URL + category if prompted). In Development mode, delivery is
limited to allow-listed test recipients; **Live** is required to serve real
patients.
Expected: the toggle reads **Live**.

### E11. Messaging limits (tiers) — how volume ramps
New numbers start at the entry tier and scale automatically as you send quality
traffic (and once business verification from E2 is **Verified**):
- **Tier 0 / unverified:** limited; test recipients only.
- **250** unique customers / 24 h → **1,000** → **10,000** → **100,000** →
  **unlimited**, stepping up based on **volume + quality rating** (Green/Yellow/
  Red in WhatsApp Manager). A **Red** quality rating can push a tier **down**.
For a single clinic, 250/day is plenty at launch; you rarely think about tiers
until outbound reminder campaigns grow. Watch **WhatsApp Manager → Insights →
Quality**; keep it Green by only messaging opted-in patients and using correct
template categories.

### E12. The 24-hour service window vs. approved templates (know this cold)
- **Inside the 24 h customer-service window** (the 24 h after the patient's last
  message): you may reply with **free-form** text — this is exactly what
  `server.js sendReply()` does, and it's the whole booking conversation. Cheap /
  often free (see E13).
- **Outside the window** (business-initiated, e.g. an **appointment reminder**
  the next day): free-form is **rejected** by Meta. You must send a
  **pre-approved message template**.
  → **Appointment reminders REQUIRE templates.** Submit them early:
  **WhatsApp Manager → Message templates → Create**, category **Utility**
  (appointment reminders/updates are Utility, not Marketing), with Arabic /
  French / English variants matching the patient's language. Approval is async
  (minutes to ~24 h; rejections for wrong category cost another cycle).
Note: the current app sends free-form replies only (in-window). Sending
templates (reminders) is a **next-step feature** — but get the templates
**approved now** so the capability is ready and you're not blocked at launch.

### E13. Pricing, the Oct 1 2026 change, and contract pass-through
- Billing is now **per-message** (moved off per-conversation in 2025).
  **Utility / Marketing / Authentication** template messages are **billable** at
  region-priced rates (Tunisia/MENA); **service** (user-initiated, in-window)
  messages have been effectively free within an allowance.
- **Oct 1, 2026 change:** Meta is revising **service-message** billing — the
  previously-free service messages/allowance change, so **budget for
  per-message service costs from Oct 1, 2026**. Confirm the live rate card in
  **WhatsApp Manager → Insights / Payment settings** at go-live (rates and the
  free-tier definition shift; don't hard-code numbers).
- Add a **valid payment method** to the WABA (Billing) or the number stops
  sending once the free allowance is exhausted.
- **Contract pass-through reminder:** OmenLabz does **not** absorb Meta's
  per-message fees. The clinic contract must **pass Meta messaging costs through**
  to the clinic (or bundle a capped allowance + overage), separate from the
  OmenLabz SaaS fee. Put this in writing **before** launch so the Oct 1 2026
  service-message change doesn't quietly eat margin.

---

## §F — Go-live checklist

Do this once §A–§E are green and the number reads **Connected + Live**. This is
the final pre-flight before you point real patients at it.

### F1. End-to-end test — real Arabic message from a Libyan number → appointment appears
The real proof: message the clinic's WhatsApp number **from an actual phone**
(ideally a Libyan `+218` number — the target patient) in Arabic to start a
booking:
```
نحب نحجز موعد قلب        (= "I'd like to book a cardiology appointment")
```
Answer each prompt in turn as the agent walks the state machine
(**specialty → date/time → full name → city of origin → contact number →
confirm** with `نعم`). Watch it live:
```bash
pm2 logs omen-clinic-agent
```
Expected: an inbound line then a `[→ <218…>] (ar/el-amen-sousse)` outbound reply
per turn. When you confirm, check the booking actually persisted:
```bash
jq '.[-1]' /opt/omen-clinic-agent/data/runtime/appointments.json
```
Expected: the newest appointment object — `status: "confirmed"`,
`clinicId: "el-amen-sousse"`, `specialty: "cardiology"`, the patient's `waId`
(the `218…` number), and a `datetime` **inside** that clinic's working hours.
If it's the last element of `appointments.json`, the whole path
WhatsApp → `POST /webhook` → engine → store → outbound send is proven.

Can't get a real `+218` number yet? Exercise the **same engine** against the
running prod process over localhost (this does NOT send via WhatsApp — it's a
smoke test only; `/simulate` is never proxied by Nginx):
```bash
curl -s -X POST localhost:3000/simulate -H 'Content-Type: application/json' \
  -d '{"from":"218910000001","text":"نحب نحجز موعد قلب","phone_number_id":"1000000001"}'
```
Send the follow-up answers (date, name, city, phone, then `نعم`) with the **same
`from`** to drive the flow to a confirmed appointment. The true go-live gate is
still a real WhatsApp message, because only that also validates the token, the
webhook subscription, and the outbound Graph send.

### F2. Confirm the inbound signature check is actually ON (`WHATSAPP_APP_SECRET`)
In production this must be set so `POST /webhook` enforces Meta's
`X-Hub-Signature-256` HMAC (`server.js verifySignature`). Check it's present:
```bash
grep -Eq '^WHATSAPP_APP_SECRET=.+' /opt/omen-clinic-agent/.env \
  && echo "APP_SECRET set — signature check ON" \
  || echo "MISSING — signature check OFF (fix .env, pm2 reload)"
```
Prove enforcement — an **unsigned** POST must be rejected before any processing:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://agent.clinic.com/webhook \
  -H 'Content-Type: application/json' \
  -d '{"object":"whatsapp_business_account","entry":[]}'
```
Expected: **`401`** (signature missing/invalid). A `200` here means the secret is
blank and the check is disabled — set it and `pm2 reload omen-clinic-agent`.
Real Meta traffic is signed and still passes; only forged/unsigned POSTs get
`401`. (`deploy.sh` also warns on an empty `WHATSAPP_APP_SECRET`.)

### F3. `/health` reachable through Nginx (not just localhost)
```bash
curl -s https://agent.clinic.com/health | jq
```
Expected: `{"ok":true,"provider":"mock",…,"clinics":[…]}` with each tenant's
`id`/`name`/`phoneNumberId`. This is exactly what `deploy.sh` and your uptime
monitor hit. Note `/health` exposes clinic names + `phone_number_id`s — if that's
sensitive, uncomment the `allow`/`deny` block in the conf to restrict it and
monitor externally with a blind TCP/443 check instead.

### F4. Install the healthcheck cron (guarded self-heal + heartbeat)
As **deploy**, `crontab -e` and add (every 5 min; `AUTO_RESTART=1` lets it issue
**one** `pm2 restart` only after 3 consecutive fails — never on the first blip,
so it can't loop):
```cron
*/5 * * * * AUTO_RESTART=1 /opt/omen-clinic-agent/deploy/healthcheck.sh >> /opt/omen-clinic-agent/logs/healthcheck.log 2>&1
```
Verify after ~10 min:
```bash
tail /opt/omen-clinic-agent/logs/healthcheck.log
```
Expected: periodic `OK  http://127.0.0.1:3000/health` lines. For an external
dead-man's switch add `PING_URL=<healthchecks.io|UptimeRobot push URL>` to the
cron line (curled only on success); add `MAILTO=you@clinic.com` at the top of
the crontab to get email on any non-zero exit.

### F5. `data/` backup cron — nightly, 7-day rotation
The entire booking history, conversation state, and tenant config live in
`data/` (`data/runtime/*.json` + the seed `data/clinics.json`). Nightly tar,
keep 7 days (note `\%F` — `%` must be escaped in crontab):
```cron
15 2 * * * tar -czf /opt/omen-clinic-agent/backups/data-$(date +\%F).tgz -C /opt/omen-clinic-agent data && find /opt/omen-clinic-agent/backups -name 'data-*.tgz' -mtime +7 -delete
```
First create the dir: `mkdir -p /opt/omen-clinic-agent/backups`. Expected: one
dated `.tgz` per night, tarballs older than 7 days pruned → a rolling week.
Restore = `tar -xzf backups/data-YYYY-MM-DD.tgz -C /opt/omen-clinic-agent` then
`pm2 reload omen-clinic-agent`. **Copy the backups off-box** (rsync/scp to
another host or object storage) on the same schedule — a local-only backup dies
with the droplet.

### F6. Rollback
Both paths preserve bookings, because `data/runtime/` and `.env` are git-ignored
and live outside version control.

**(a) Fast path — the exact command `deploy.sh` prints after every deploy:**
```bash
cd /opt/omen-clinic-agent
git reset --hard <PREV_SHA>     # deploy.sh echoes this SHA on every run
./deploy/deploy.sh              # npm ci → node --check → pm2 startOrReload → /health gate
```
Expected: the old SHA is reinstalled, PM2 reloaded, and `deploy.sh` polls
`/health` until green (or fails loudly and tells you). `git reset --hard` does
**not** touch git-ignored paths, so `data/runtime/*.json` and `.env` are
untouched.

**(b) Previous-release directory pattern** (tarball deploys / instant flip):
keep timestamped releases and repoint a symlink, with `data/` + `.env` shared
**outside** the release dirs so a rollback never loses bookings:
```bash
# /opt/releases/<ts>/ = full checkout;  /opt/shared/{data,.env} symlinked into each
ln -sfn /opt/releases/2026-07-18-1200 /opt/omen-clinic-agent   # point at known-good
pm2 reload omen-clinic-agent                                    # graceful restart (fork)
```
On the single fork instance, `pm2 reload` is a sub-second graceful restart; Meta
retries any webhook delivered during the blip, so nothing is lost. (The
ecosystem's `cwd: /opt/omen-clinic-agent` resolves through the symlink; keep
`data/` and `.env` symlinked in so `config.js` finds them.)

### F7. Owner notification digests (cron — NOT an in-process scheduler)
Instant owner alerts (new booking ✅, hot lead 🔥, handoff 🙋, emergency 🚨) fire
live from the running app. The **daily / weekly digests** (the §3.4 "money line")
are deliberately NOT scheduled inside the process — run them from cron so a
reload never double-fires and a crash never drops one. Add two lines (clinic-local
08:00; set `TZ` per clinic):
```cron
0 8 * * *  cd /opt/omen-clinic-agent && TZ=Africa/Tunis /usr/bin/npm run --silent digest:daily  >> logs/digest.log 2>&1
0 8 * * 1  cd /opt/omen-clinic-agent && TZ=Africa/Tunis /usr/bin/npm run --silent digest:weekly >> logs/digest.log 2>&1
```
Each run iterates every tenant and sends via the same WhatsApp gateway, honoring
per-recipient `notification_prefs` (language, per-event on/off, daily/weekly
toggles); digests ignore quiet-hours since cron already picks the hour.
Recipients default to the clinic's escalation/owner number when no prefs row
exists, so digests work before any per-tenant setup. Owner alert preferences are
edited under **Settings → Notifications** in the dashboard. Test once by hand:
`npm run digest:daily` (offline it writes to the mock outbox; with `WHATSAPP_TOKEN`
set it sends real messages). Use `scripts/run-digest.js` directly for ad-hoc runs.

---

## §G — Multi-tenant onboarding & scaling limits

One process already serves **every** clinic in `data/clinics.json`. Inbound
messages are routed purely by `phone_number_id` →
`data/clinics.json → whatsapp.phoneNumberId` (`store.getClinicByPhoneNumberId`),
so all clinics share one app, one webhook, and one token.

### G1. Onboard a new clinic = one `clinics.json` entry + a reload
1. **Do §E for that clinic's real number.** It gets its own `phone_number_id`,
   added to a WABA the System User can access. The **same** permanent
   `WHATSAPP_TOKEN` serves every clinic as long as it has asset access to each
   WABA. Point the **same** webhook — every number under the app delivers to the
   one `https://agent.clinic.com/webhook`; the app fans out by `phone_number_id`.
2. **Add a tenant object** to the `clinics` array in `data/clinics.json`, keyed
   by that number's production `phone_number_id`. Copy the `el-amen-sousse` entry
   as a template and fill: `id` (slug), `name`, `city`, `country`, `timezone`
   (`Africa/Tunis`), `currency`, `whatsapp.phoneNumberId` (the REAL id from §E5)
   + `displayPhone`, `handoff`, `languages`, `specialties` (each with `ar`/`fr`/
   `en` `labels` + `synonyms`), `workingHours`, `pricing`, `travel`, and `faq`.
3. **Validate the JSON before reloading** — a malformed `clinics.json` crashes
   the store at boot (`createStore` does `JSON.parse(readFileSync(...))`):
   ```bash
   cd /opt/omen-clinic-agent
   jq . data/clinics.json >/dev/null && echo "clinics.json valid"
   ```
4. **Reload so the process re-reads the seed.** The store parses `clinics.json`
   **once at startup** — a running process will NOT see your edit until reload:
   ```bash
   pm2 reload omen-clinic-agent
   ```
5. **Confirm it's live:**
   ```bash
   curl -s localhost:3000/health | jq '.clinics'
   ```
   Expected: the new clinic appears with its `id`/`name`/`phoneNumberId`. A test
   WhatsApp message to its number now routes to it.

> **Gotcha:** `clinics.json` is **tracked in git** (it's the seed), and
> `deploy.sh` runs `git reset --hard origin/<branch>`. A clinic added directly on
> the box will be **wiped on the next deploy** unless you commit it. Preferred
> flow: edit `clinics.json` in the repo → commit → push → `deploy.sh`. If you
> hotfixed on the box for speed, commit the same change back immediately.

### G2. ⚠️ SCALING LIMIT — RUN EXACTLY ONE INSTANCE. NON-NEGOTIABLE. ⚠️
**Do NOT run more than one process against this store. Ever — until you migrate
off JSON files (§G3).** `src/store/index.js` reads each collection into an
**in-memory array at boot** (`db.patients/conversations/appointments`) and
rewrites the **entire file** on every `persist()` (`writeFileSync` of the whole
array). Two or more instances each hold their own copy and **last-writer-wins
clobbers the others' writes** → lost bookings and split/rewound per-patient
conversation state.

Concretely, this means:
- `ecosystem.config.cjs` pins `exec_mode: 'fork'`, `instances: 1` — a **hard
  constraint**, not a tuning knob. Leave it.
- **Do NOT** set `instances > 1`. **Do NOT** switch to `cluster` mode. **Do NOT**
  run a second box/container against the same `data/` dir. **Do NOT** put two app
  hosts behind the Nginx upstream.
- Therefore there is **no horizontal scale and no built-in HA/failover** on the
  JSON store. Your only lever is **vertical** (a bigger VPS). One fork instance
  comfortably serves many low-volume clinics (idles ~40–70 MB, booking is cheap);
  the ceiling is write throughput / the whole-file rewrite, **not** tenant count.

### G3. When (and how) to move to Postgres/Redis
Migrate when **any** of these becomes true:
- You need **more than one instance**: HA/failover, zero-downtime cluster
  reloads, or horizontal scale for burst load.
- **Write latency/contention**: `appointments.json` / `conversations.json` grow
  and the **O(n) whole-file rewrite on every message** starts to bite (thousands
  of bookings, or high concurrent volume across many busy clinics).
- **Concurrent writers / an admin API**: a dashboard or onboarding API writing
  tenants/appointments while the agent runs.
- **Reliability features**: an outbound send queue with retries + **idempotency
  on Meta's `message.id`**, templated-reminder scheduling at scale, analytics.

**How — the seam is deliberately tiny.** `src/store/index.js` is the *single*
interface to reimplement. Keep the same method names — `listClinics`,
`getClinicById`, `getClinicByPhoneNumberId`, `getDefaultClinic`, `upsertPatient`,
`getConversation`, `newConversation`, `saveConversation`, `createAppointment`,
`listAppointments` — backed by **Postgres** (tenants + patients + conversations +
appointments tables; move clinics out of the seed file into a table with an admin
API) and, optionally, **Redis** for hot per-patient conversation state and the
outbound send queue. Nothing in `server.js` or `engine/*` changes — they only
ever call those store methods. Once persistence is external and shared you can
raise `instances`, enable cluster mode, and add 2+ app hosts to the Nginx
`upstream omen_clinic_agent` block — at which point make sends idempotent on
`message.id` so retries are safe across instances.

---

## §H — Dashboard onboarding (first-owner setup)

The admin dashboard is served by the **same** Express process: once §B3 built
`web/dist` and §D put the app behind TLS, the Vite/React SPA is live at the site
root (`/`). Bring the first clinic owner online like this:

1. **Confirm the build is served.**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<your-domain>/
   ```
   Expected `200`. If the page shows a *"Dashboard not built yet"* notice, the
   server is up but `web/dist` is missing — re-run `npm run web:build` (§B3) and
   `pm2 reload omen-clinic-agent`.

2. **Create the first owner (one-time bootstrap).** Open `https://<your-domain>/`
   in a browser → **First-time setup** → enter the clinic **id** exactly as in
   `data/clinics.json` (e.g. `el-amen-sousse`), the owner's email, and a strong
   password. This route is a bootstrap only: it is **refused once an owner already
   exists** for that tenant, so there is no open self-registration to disable
   afterwards. Session cookies are signed with **`APP_SECRET`** — set a strong one
   in §B or every session is forgeable.

3. **Run the onboarding wizard.** The new owner lands in the wizard: profile →
   persona → knowledge base → medical-tourism → **escalation number** (where the
   owner alerts of §F7 are delivered) → **test drive** → go-live. The test drive
   (and later Settings → sandbox) talk to the live engine with the clinic's own
   data — **including the emergency guardrail** — without writing to the live
   inbox or firing owner alerts. Finishing the wizard flips the clinic live; from
   then the **live inbox** (with human takeover), **appointments**, **knowledge
   base**, and **notification preferences** (Settings → Notifications) are all in
   the dashboard.

Repeat step 2 for each clinic. Every account is **tenant-scoped**: an owner sees
only their own clinic's data (resolution stays keyed on `phone_number_id` →
tenant; enforced end-to-end and covered by `test/api.isolation.test.js`). During
`web/` development, `npm run web:dev` serves the SPA on `:5173` and proxies the
API to `:3000` so cookies + SSE stay same-origin.

---

*End of runbook. Sections §A–§H cover a full single-VPS production deployment of
omen-clinic-agent. Keep this file in the repo (`deploy/RUNBOOK.md`) so it
versions alongside the code and configs it references.*
