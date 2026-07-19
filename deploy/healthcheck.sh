#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  healthcheck.sh — liveness probe for omen-clinic-agent, built for cron.
#
#  Curls /health, checks for {"ok":true}. Tracks CONSECUTIVE failures in a state
#  file so a single blip doesn't trigger action. Optionally (guarded) restarts
#  the PM2 process after N consecutive failures — never on the first failure, so
#  it cannot cause a restart loop.
#
#  Exit codes (Nagios-compatible):
#     0  OK        — healthy
#     2  CRITICAL  — unreachable or "ok" not true
#
#  Cron (every 5 minutes) — run as the deploy user, log to a file:
#     */5 * * * * AUTO_RESTART=1 /opt/omen-clinic-agent/deploy/healthcheck.sh \
#                   >> /opt/omen-clinic-agent/logs/healthcheck.log 2>&1
#
#  Leave AUTO_RESTART unset to alert-only (recommended once you also have an
#  external monitor). Point MAILTO= at the top of the crontab to get emails on
#  any non-zero exit. For an external heartbeat, set PING_URL (healthchecks.io /
#  UptimeRobot push URL) — it is curled only on success.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail   # NOT -e: we handle failures explicitly and must reach the exit

# ── Config (override via env) ────────────────────────────────────────────────
PORT="${PORT:-3000}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/health}"
APP_NAME="${APP_NAME:-omen-clinic-agent}"
STATE_FILE="${STATE_FILE:-/tmp/omen-clinic-agent.health.fails}"
MAX_FAILS="${MAX_FAILS:-3}"          # consecutive fails before a guarded restart
AUTO_RESTART="${AUTO_RESTART:-0}"    # 1 = allow guarded pm2 restart
PING_URL="${PING_URL:-}"             # optional external heartbeat on success
TS="$(date '+%Y-%m-%d %H:%M:%S %z')"

read_fails()  { [ -f "$STATE_FILE" ] && cat "$STATE_FILE" 2>/dev/null || echo 0; }
write_fails() { echo "$1" > "$STATE_FILE" 2>/dev/null || true; }

# ── Probe ────────────────────────────────────────────────────────────────────
if body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)" \
     && printf '%s' "$body" | grep -q '"ok":true'; then
  # Healthy: reset counter, optional heartbeat, done.
  prev="$(read_fails)"
  write_fails 0
  [ "$prev" != "0" ] && echo "$TS  RECOVERED after $prev fail(s): $HEALTH_URL"
  [ -n "$PING_URL" ] && curl -fsS --max-time 5 "$PING_URL" >/dev/null 2>&1 || true
  echo "$TS  OK  $HEALTH_URL"
  exit 0
fi

# ── Unhealthy ────────────────────────────────────────────────────────────────
fails="$(read_fails)"
fails=$((fails + 1))
write_fails "$fails"
echo "$TS  CRITICAL  $HEALTH_URL unreachable or not ok (consecutive fails: $fails)" >&2

# Guarded self-heal: only with AUTO_RESTART=1 AND at/over the threshold.
if [ "$AUTO_RESTART" = "1" ] && [ "$fails" -ge "$MAX_FAILS" ]; then
  if command -v pm2 >/dev/null 2>&1; then
    echo "$TS  ACTION  $fails >= $MAX_FAILS — restarting PM2 process '$APP_NAME'" >&2
    pm2 restart "$APP_NAME" --update-env >/dev/null 2>&1 \
      && echo "$TS  ACTION  pm2 restart issued" >&2 \
      || echo "$TS  ACTION  pm2 restart FAILED" >&2
    write_fails 0   # reset so we give the restart time before acting again
  else
    echo "$TS  ACTION  pm2 not found — cannot self-heal" >&2
  fi
fi

exit 2
