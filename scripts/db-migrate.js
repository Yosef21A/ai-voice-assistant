// Migration runner. Applies sql/*.sql in filename order inside a transaction
// each, recording applied versions (+ a checksum) in schema_migrations so it is
// idempotent and safe to re-run. Reads DATABASE_URL via src/config.js.
//
//   npm run db:migrate
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getConfig } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(__dirname, '..', 'sql');

async function main() {
  const config = getConfig();
  const url = config.databaseUrl || process.env.DATABASE_URL;
  if (!url) {
    console.error('db:migrate — DATABASE_URL is not set. Nothing to do.');
    process.exit(1);
  }
  const files = readdirSync(SQL_DIR)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();
  if (!files.length) {
    console.log('db:migrate — no sql/*.sql files found.');
    return;
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Map(
      (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum])
    );

    let count = 0;
    for (const f of files) {
      const version = f.replace(/\.sql$/, '');
      const sql = readFileSync(path.join(SQL_DIR, f), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
      if (applied.has(version)) {
        if (applied.get(version) !== checksum) {
          console.warn(`! ${f} already applied but checksum changed (db=${applied.get(version)} file=${checksum}) — not re-running`);
        } else {
          console.log(`= skip ${f} (already applied)`);
        }
        continue;
      }
      process.stdout.write(`> applying ${f} ... `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
        await client.query('COMMIT');
        console.log('ok');
        count++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.log('FAILED');
        throw err;
      }
    }
    console.log(`\ndb:migrate — done: ${count} applied, ${files.length - count} already present.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\ndb:migrate error:', err.message);
  process.exit(1);
});
