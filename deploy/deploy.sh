#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  deploy.sh — idempotent deploy for omen-clinic-agent
#
#  Pulls the latest code, installs prod deps, syntax-checks, (re)starts under
#  PM2, then polls /health until the new process is actually serving. Safe to
#  run repeatedly. Run as the NON-ROOT deploy user from anywhere.
#
#    ./deploy/deploy.sh                 # deploy origin/main into $APP_DIR
#    BRANCH=release ./deploy/deploy.sh  # deploy a different branch
#    APP_DIR=~/apps/omen ./deploy/deploy.sh
#
#  Exit codes: 0 ok · 1 preflight/env · 2 git · 3 npm · 4 syntax · 5 pm2 · 6 health
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────────
APP_DIR="${APP_DIR:-/opt/omen-clinic-agent}"
APP_NAME="${APP_NAME:-omen-clinic-agent}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3000}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/health}"
ECOSYSTEM="deploy/ecosystem.config.cjs"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"
HEALTH_DELAY="${HEALTH_DELAY:-2}"

# ── Colors (auto-disabled when not a TTY) ────────────────────────────────────
if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[0;33m'
  C_BLU=$'\033[0;34m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_DIM=''; C_RST=''
fi
info() { printf '%s==>%s %s\n' "$C_BLU" "$C_RST" "$*"; }
ok()   { printf '%s ✓ %s%s\n'  "$C_GRN" "$*" "$C_RST"; }
warn() { printf '%s ! %s%s\n'  "$C_YEL" "$*" "$C_RST"; }
die()  { printf '%s ✗ %s%s\n'  "$C_RED" "$*" "$C_RST" >&2; exit "${2:-1}"; }

# ── 1. Preflight ─────────────────────────────────────────────────────────────
info "Preflight"
[ -d "$APP_DIR" ] || die "APP_DIR not found: $APP_DIR" 1
cd "$APP_DIR"
command -v git  >/dev/null 2>&1 || die "git not installed" 1
command -v node >/dev/null 2>&1 || die "node not installed" 1
command -v npm  >/dev/null 2>&1 || die "npm not installed" 1
command -v pm2  >/dev/null 2>&1 || die "pm2 not installed (npm i -g pm2)" 1
[ -f "$ECOSYSTEM" ] || die "missing $ECOSYSTEM (run from repo root)" 1
if [ ! -f .env ]; then
  die ".env missing — cp deploy/.env.production.example .env && chmod 600 .env" 1
fi
# Warn (don't fail) on prod hygiene gaps.
if grep -qE '^\s*WHATSAPP_APP_SECRET\s*=\s*$' .env; then
  warn "WHATSAPP_APP_SECRET is empty — inbound signature check is DISABLED"
fi
if grep -qE '^\s*WHATSAPP_VERIFY_TOKEN\s*=\s*omen-verify-dev\s*$' .env; then
  warn "WHATSAPP_VERIFY_TOKEN is still the dev default — rotate it"
fi
ok "Preflight passed (app=$APP_NAME dir=$APP_DIR branch=$BRANCH)"

# ── 2. Fetch latest code (idempotent) ────────────────────────────────────────
info "Syncing code from origin/$BRANCH"
PREV_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo none)"
git fetch --all --prune            || die "git fetch failed" 2
git checkout "$BRANCH"             || die "git checkout $BRANCH failed" 2
git reset --hard "origin/$BRANCH" || die "git reset failed" 2
NEW_SHA="$(git rev-parse --short HEAD)"
if [ "$PREV_SHA" = "$NEW_SHA" ]; then
  ok "Already at $NEW_SHA (no code change) — will still reload"
else
  ok "Code $PREV_SHA -> $NEW_SHA"
fi
printf '%s   rollback with: git reset --hard %s && ./deploy/deploy.sh%s\n' \
  "$C_DIM" "$PREV_SHA" "$C_RST"

# ── 3. Install dependencies (FULL — the dashboard build needs the dev toolchain)
info "Installing dependencies (npm ci)"
npm ci || die "npm ci failed" 3
mkdir -p logs data/runtime
ok "Dependencies installed"

# ── 3b. Build the dashboard SPA (Vite → web/dist, served at / by Express) ─────
# web/dist is git-ignored, so it is (re)built on every deploy. Then prune the
# dev-only build toolchain so the running process keeps a lean footprint.
info "Building the dashboard SPA (npm run web:build)"
npm run web:build || die "web:build failed (dashboard not built)" 3
ok "Dashboard built (web/dist)"
info "Pruning dev dependencies (npm prune --omit=dev)"
npm prune --omit=dev || warn "npm prune failed — dev deps remain (not fatal)"
ok "Runtime dependencies only"

# ── 4. Syntax / config test ──────────────────────────────────────────────────
info "Syntax-checking entry point"
node --check src/server.js || die "src/server.js failed node --check" 4
node --check "$ECOSYSTEM"  || die "$ECOSYSTEM failed node --check" 4
ok "Syntax OK"

# ── 5. Start or reload under PM2 ──────────────────────────────────────────────
info "PM2 startOrReload ($ECOSYSTEM --env production)"
pm2 startOrReload "$ECOSYSTEM" --env production || die "pm2 startOrReload failed" 5
pm2 save >/dev/null 2>&1 || warn "pm2 save failed (startup list not updated)"
ok "PM2 reloaded"

# ── 6. Health gate ───────────────────────────────────────────────────────────
info "Waiting for $HEALTH_URL (up to $((HEALTH_RETRIES * HEALTH_DELAY))s)"
attempt=1
while [ "$attempt" -le "$HEALTH_RETRIES" ]; do
  if body="$(curl -fsS --max-time 4 "$HEALTH_URL" 2>/dev/null)" \
       && printf '%s' "$body" | grep -q '"ok":true'; then
    ok "Healthy on attempt $attempt"
    printf '%s   %s%s\n' "$C_DIM" "$body" "$C_RST"
    printf '\n%s✓ DEPLOY OK%s  %s @ %s\n' "$C_GRN" "$C_RST" "$APP_NAME" "$NEW_SHA"
    exit 0
  fi
  printf '%s   attempt %d/%d not ready, retrying in %ss…%s\n' \
    "$C_DIM" "$attempt" "$HEALTH_RETRIES" "$HEALTH_DELAY" "$C_RST"
  attempt=$((attempt + 1))
  sleep "$HEALTH_DELAY"
done

warn "Health check never passed — dumping recent logs:"
pm2 logs "$APP_NAME" --lines 30 --nostream 2>/dev/null || true
die "UNHEALTHY after deploy. Roll back: git reset --hard $PREV_SHA && ./deploy/deploy.sh" 6
