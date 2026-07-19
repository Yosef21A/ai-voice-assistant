/**
 * PM2 ecosystem for omen-clinic-agent (OmenLabz WhatsApp clinic agent).
 *
 * This file is intentionally `.cjs` (CommonJS): the app itself is an ES module
 * ("type": "module" in package.json), but PM2 loads its ecosystem file with
 * require(), which needs CommonJS. The `.cjs` extension forces that regardless
 * of the package "type".
 *
 * Usage (from the app root, e.g. /opt/omen-clinic-agent):
 *   pm2 start   deploy/ecosystem.config.cjs --env production
 *   pm2 reload  deploy/ecosystem.config.cjs --env production   # zero-downtime-ish
 *   pm2 startOrReload deploy/ecosystem.config.cjs --env production   # used by deploy.sh
 *
 * SECRETS DO NOT LIVE HERE. All WhatsApp/Anthropic secrets are read from the
 * app's own `.env` (loaded by src/config.js, chmod 600, git-ignored). This file
 * only sets NODE_ENV and PORT so it is safe to commit. src/config.js lets real
 * process.env win over `.env`, so anything set below overrides the `.env` value.
 */
module.exports = {
  apps: [
    {
      name: 'omen-clinic-agent',
      // Entry point is resolved relative to `cwd` below.
      script: 'src/server.js',
      cwd: '/opt/omen-clinic-agent',

      // ── Concurrency ─────────────────────────────────────────────────────────
      // fork + a SINGLE instance is mandatory, not a tuning choice.
      // src/store/index.js is a JSON-file store (data/runtime/*.json) with an
      // in-memory copy that it rewrites on every persist(). Two or more instances
      // would each hold their own copy and clobber each other's writes — lost
      // bookings and split per-patient conversation state. Do NOT switch to
      // cluster mode or instances > 1 until the store is moved to Postgres/Redis
      // (see RUNBOOK §G). This is a hard constraint.
      exec_mode: 'fork',
      instances: 1,

      // ── Runtime environment ─────────────────────────────────────────────────
      // Base env (applied always). PORT here matches src/config.js default (3000)
      // and the Nginx upstream. Change in ONE place if you move the port.
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      // Selected with `--env production`.
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      // ── Node flags ──────────────────────────────────────────────────────────
      // None required: the app is native ESM on Node >= 18 and has a tiny heap.
      // Kept explicit so it is obvious nothing is being injected. If you ever
      // raise max_memory_restart, mirror it here, e.g.
      // node_args: ['--max-old-space-size=384'].
      node_args: [],

      // ── Health / restart policy ─────────────────────────────────────────────
      autorestart: true,
      watch: false,                 // never watch files in production
      max_memory_restart: '300M',   // ~4x normal RSS; a leak restarts cleanly
      min_uptime: '10s',            // < 10s alive = counts as a crash
      max_restarts: 10,             // give up after 10 fast crashes -> "errored"
      restart_delay: 4000,          // wait 4s between restarts
      exp_backoff_restart_delay: 200, // exponential backoff on crash-looping
      kill_timeout: 5000,           // 5s for in-flight webhook handling to drain
      listen_timeout: 8000,         // wait up to 8s for the port to bind

      // ── Logs ────────────────────────────────────────────────────────────────
      // Absolute paths under the app dir (create ./logs, owned by the deploy
      // user — see RUNBOOK §C). time:true prefixes every line with a timestamp;
      // merge_logs keeps a single stream in fork mode. Rotation is handled by the
      // pm2-logrotate module (RUNBOOK §C), not here.
      out_file: '/opt/omen-clinic-agent/logs/omen-clinic-agent.out.log',
      error_file: '/opt/omen-clinic-agent/logs/omen-clinic-agent.err.log',
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
