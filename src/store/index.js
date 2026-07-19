// Storage factory. Returns an adapter implementing the interface documented in
// src/store/README.md. The JSON (file-backed) adapter is the zero-config default;
// the Postgres adapter is selected via explicit opts.
//
// Selection is from EXPLICIT opts ONLY (opts.store / opts.databaseUrl) — the
// factory deliberately does NOT read process.env itself. This keeps the
// synchronous engine and the existing test suite on the JSON adapter regardless
// of ambient env vars. The composition layer surfaces env through getConfig()
// (config.databaseUrl / config.store) and passes them in when it wants Postgres
// (see the migrate/seed scripts and test/store.postgres.test.js).
//
// createStore() stays SYNCHRONOUS-returning so existing callers (server.js,
// simulate.js, tests) are unchanged. The Postgres pool connects lazily on first
// query, and `pg` is required lazily inside the Postgres adapter, so JSON-only
// runs never load it.
import { createJsonStore } from './adapters/json/index.js';
import { createPostgresStore } from './adapters/postgres/index.js';

/**
 * @param {object} opts
 * @param {'json'|'postgres'} [opts.store]  force an adapter
 * @param {string} [opts.databaseUrl]       Postgres URL (implies 'postgres')
 * @param {string} [opts.clinicsFile]       JSON adapter: seed file
 * @param {string} [opts.runtimeDir]        JSON adapter: persistence dir
 * @param {boolean} [opts.reset]            JSON adapter: wipe runtimeDir first
 */
export function createStore(opts = {}) {
  const kind = opts.store || (opts.databaseUrl ? 'postgres' : 'json');
  if (kind === 'postgres') {
    return createPostgresStore({ databaseUrl: opts.databaseUrl, poolMax: opts.poolMax });
  }
  if (kind !== 'json') {
    throw new Error(`createStore: unknown store kind '${kind}' (expected 'json' | 'postgres')`);
  }
  return createJsonStore(opts);
}

export { createJsonStore, createPostgresStore };
