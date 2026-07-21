// Media retention sweep (P2-D) — deletes stored patient media older than
// MEDIA_RETENTION_DAYS (default 90). Patient data must not accumulate forever
// (CLAUDE.md guardrail); the inbox shows "file unavailable" for purged items
// (the auth-gated route 404s cleanly — message metadata rows are kept).
//
// Cron (alongside the digests, see deploy/RUNBOOK.md §F7):
//   15 3 * * *  cd /opt/omen-clinic-agent && npm run --silent media:purge >> logs/purge.log 2>&1
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';

/**
 * Walk {mediaDir}/{tenantId}/{yyyymm}/ and unlink files whose mtime is older
 * than `retentionDays`. Empty month/tenant directories are removed after.
 * @returns {{removed:number, kept:number}}
 */
export function purgeMediaDir(mediaDir, retentionDays, now = new Date()) {
  const cutoff = now.getTime() - retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  let kept = 0;
  let skipped = 0;
  if (!fs.existsSync(mediaDir)) return { removed, kept, skipped };

  // lstat (never follow symlinks — a link can't drag the sweep outside
  // mediaDir) + per-entry try/catch (one dangling entry must not abort the
  // whole retention run).
  const safeLstat = (p) => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  };

  for (const tenant of fs.readdirSync(mediaDir)) {
    const tenantDir = path.join(mediaDir, tenant);
    if (!safeLstat(tenantDir)?.isDirectory()) continue;
    for (const month of fs.readdirSync(tenantDir)) {
      const monthDir = path.join(tenantDir, month);
      if (!safeLstat(monthDir)?.isDirectory()) continue;
      for (const f of fs.readdirSync(monthDir)) {
        const abs = path.join(monthDir, f);
        try {
          const st = safeLstat(abs);
          if (!st?.isFile()) {
            skipped += 1; // symlink / stray dir / vanished entry
            continue;
          }
          if (st.mtimeMs < cutoff) {
            fs.unlinkSync(abs);
            removed += 1;
          } else {
            kept += 1;
          }
        } catch {
          skipped += 1;
        }
      }
      try {
        if (fs.readdirSync(monthDir).length === 0) fs.rmdirSync(monthDir);
      } catch {
        /* non-empty or busy — leave it */
      }
    }
    try {
      if (fs.readdirSync(tenantDir).length === 0) fs.rmdirSync(tenantDir);
    } catch {
      /* non-empty or busy — leave it */
    }
  }
  return { removed, kept, skipped };
}

// CLI entrypoint (skipped when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = getConfig();
  const { removed, kept, skipped } = purgeMediaDir(config.mediaDir, config.mediaRetentionDays);
  console.log(
    `[media:purge] retention=${config.mediaRetentionDays}d dir=${config.mediaDir} removed=${removed} kept=${kept} skipped=${skipped}`
  );
}
