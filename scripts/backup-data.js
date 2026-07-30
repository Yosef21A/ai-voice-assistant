// Nightly data/ backup (P2-F). Cross-platform (no tar/zip dependency): copies
// data/ → backups/data-YYYYMMDD-HHMMSS/ and prunes to the newest KEEP copies.
// Cron line (RUNBOOK §F5): 15 2 * * *  cd /opt/omen-clinic-agent && npm run backup
//
//   npm run backup            → one snapshot + prune
//   BACKUP_KEEP=30 npm run backup
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`[backup] nothing to back up — ${DATA_DIR} does not exist`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `data-${stamp()}`);
  fs.cpSync(DATA_DIR, dest, { recursive: true });
  console.log(`[backup] ${DATA_DIR} → ${dest}`);

  const snapshots = fs
    .readdirSync(BACKUP_DIR)
    .filter((n) => n.startsWith('data-'))
    .sort(); // stamp format sorts chronologically
  const excess = snapshots.length - KEEP;
  for (let i = 0; i < excess; i++) {
    const victim = path.join(BACKUP_DIR, snapshots[i]);
    fs.rmSync(victim, { recursive: true, force: true });
    console.log(`[backup] pruned ${victim}`);
  }
  console.log(`[backup] done — keeping newest ${Math.min(snapshots.length, KEEP)} snapshot(s)`);
}

main();
