// Seed script. Imports data/clinics.json into the `tenants` table (and each
// clinic's FAQ into `kb_entries`) so a freshly migrated database mirrors the
// prototype's multi-tenant registry. Idempotent (upsert on natural keys).
// Reads DATABASE_URL via src/config.js.
//
//   npm run db:seed
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { getConfig } from '../src/config.js';

async function main() {
  const config = getConfig();
  const url = config.databaseUrl || process.env.DATABASE_URL;
  if (!url) {
    console.error('db:seed — DATABASE_URL is not set. Nothing to do.');
    process.exit(1);
  }
  const clinics = JSON.parse(readFileSync(config.clinicsFile, 'utf8')).clinics || [];

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    let tenants = 0;
    let kb = 0;
    for (const c of clinics) {
      await client.query(
        `INSERT INTO tenants
           (id, phone_number_id, name, city, country, timezone, currency, languages, config, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'active')
         ON CONFLICT (id) DO UPDATE SET
           phone_number_id = EXCLUDED.phone_number_id, name = EXCLUDED.name, city = EXCLUDED.city,
           country = EXCLUDED.country, timezone = EXCLUDED.timezone, currency = EXCLUDED.currency,
           languages = EXCLUDED.languages, config = EXCLUDED.config`,
        [
          c.id, c.whatsapp?.phoneNumberId ?? null, c.name, c.city ?? null, c.country ?? null,
          c.timezone ?? null, c.currency ?? null, JSON.stringify(c.languages ?? []), JSON.stringify(c),
        ]
      );
      tenants++;
      for (const f of c.faq ?? []) {
        await client.query(
          `INSERT INTO kb_entries (tenant_id, key, question, answer, keywords, source, status)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'import','active')
           ON CONFLICT (tenant_id, key) DO UPDATE SET
             answer = EXCLUDED.answer, keywords = EXCLUDED.keywords, source = EXCLUDED.source`,
          [c.id, f.id, f.id, JSON.stringify(f.answer ?? {}), JSON.stringify(f.keywords ?? [])]
        );
        kb++;
      }
    }
    console.log(`db:seed — done: ${tenants} tenants, ${kb} kb_entries upserted.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('db:seed error:', err.message);
  process.exit(1);
});
