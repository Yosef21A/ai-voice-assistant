// PostgreSQL storage adapter. Implements the async collection interface in
// src/store/README.md, selected when a DATABASE_URL (or store:'postgres') is
// provided.
//
// Guarantees:
//   * Parameterized queries ONLY (no string interpolation of values).
//   * Every tenant-owned query is scoped by tenant_id — reads and writes for
//     tenant A can never touch tenant B's rows through this API.
//   * A shared connection pool; graceful shutdown via close().
//
// `pg` is required LAZILY (createRequire) so JSON-only deployments never load it.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// snake_case row -> camelCase object. jsonb/arrays are already parsed by pg;
// timestamptz comes back as JS Date. Returns null for missing rows.
const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const row2obj = (r) =>
  r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [toCamel(k), v])) : null;
const rows2obj = (rows) => rows.map(row2obj);

/**
 * @param {object} opts
 * @param {string} opts.databaseUrl  postgres connection string
 * @param {number} [opts.poolMax]    max pool clients (default 10 / PGPOOL_MAX)
 */
export function createPostgresStore({ databaseUrl, poolMax } = {}) {
  if (!databaseUrl) throw new Error('createPostgresStore: databaseUrl is required');
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(poolMax) || Number(process.env.PGPOOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
  // Never let an idle-client error crash the process.
  pool.on('error', (err) => console.error('[store:pg] idle client error:', err.message));
  const q = (text, params) => pool.query(text, params);
  const fallbackRef = () =>
    `REF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

  const tenants = {
    async getByPhoneNumberId(pnid) {
      if (pnid == null) return null;
      const { rows } = await q('SELECT * FROM tenants WHERE phone_number_id = $1', [String(pnid)]);
      return row2obj(rows[0]);
    },
    async getById(id) {
      const { rows } = await q('SELECT * FROM tenants WHERE id = $1', [id]);
      return row2obj(rows[0]);
    },
    async list() {
      const { rows } = await q('SELECT * FROM tenants ORDER BY name');
      return rows2obj(rows);
    },
    async upsert(t) {
      if (!t?.id) throw new Error('tenants.upsert: id required');
      const { rows } = await q(
        `INSERT INTO tenants
           (id, phone_number_id, name, city, country, timezone, currency, languages, config, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,COALESCE($10,'active'))
         ON CONFLICT (id) DO UPDATE SET
           phone_number_id = EXCLUDED.phone_number_id, name = EXCLUDED.name,
           city = EXCLUDED.city, country = EXCLUDED.country, timezone = EXCLUDED.timezone,
           currency = EXCLUDED.currency, languages = EXCLUDED.languages,
           config = EXCLUDED.config, status = EXCLUDED.status
         RETURNING *`,
        [
          t.id, t.phoneNumberId ?? null, t.name ?? t.id, t.city ?? null, t.country ?? null,
          t.timezone ?? null, t.currency ?? null, JSON.stringify(t.languages ?? []),
          JSON.stringify(t.config ?? {}), t.status ?? null,
        ]
      );
      return row2obj(rows[0]);
    },
  };

  const patients = {
    async upsert(tenantId, waId, patch = {}) {
      const { rows } = await q(
        `INSERT INTO patients
           (tenant_id, wa_id, name, origin_city, origin_country, contact, lang, last_seen_at, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (tenant_id, wa_id) DO UPDATE SET
           name           = COALESCE(EXCLUDED.name,           patients.name),
           origin_city    = COALESCE(EXCLUDED.origin_city,    patients.origin_city),
           origin_country = COALESCE(EXCLUDED.origin_country, patients.origin_country),
           contact        = COALESCE(EXCLUDED.contact,        patients.contact),
           lang           = COALESCE(EXCLUDED.lang,           patients.lang),
           last_seen_at   = COALESCE(EXCLUDED.last_seen_at,   patients.last_seen_at),
           meta           = patients.meta || EXCLUDED.meta
         RETURNING *`,
        [
          tenantId, waId, patch.name ?? null, patch.originCity ?? null, patch.originCountry ?? null,
          patch.contact ?? null, patch.lang ?? null, patch.lastSeen ?? patch.lastSeenAt ?? null,
          JSON.stringify(patch.meta ?? {}),
        ]
      );
      return row2obj(rows[0]);
    },
    async get(tenantId, waId) {
      const { rows } = await q('SELECT * FROM patients WHERE tenant_id = $1 AND wa_id = $2', [tenantId, waId]);
      return row2obj(rows[0]);
    },
    async list(tenantId) {
      const { rows } = await q('SELECT * FROM patients WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
      return rows2obj(rows);
    },
  };

  const conversations = {
    async get(tenantId, patientWaId) {
      const { rows } = await q(
        'SELECT * FROM conversations WHERE tenant_id = $1 AND patient_wa_id = $2',
        [tenantId, patientWaId]
      );
      return row2obj(rows[0]);
    },
    async getById(tenantId, id) {
      const { rows } = await q('SELECT * FROM conversations WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
      return row2obj(rows[0]);
    },
    async create(tenantId, { patientWaId, patientId = null, lang = null, status = 'open', aiPaused = false, state = null } = {}) {
      const { rows } = await q(
        `INSERT INTO conversations (tenant_id, patient_wa_id, patient_id, lang, status, ai_paused, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (tenant_id, patient_wa_id) DO UPDATE SET updated_at = now()
         RETURNING *`,
        [tenantId, patientWaId, patientId, lang, status, aiPaused, state == null ? null : JSON.stringify(state)]
      );
      return row2obj(rows[0]);
    },
    async list(tenantId, filter = {}) {
      const cond = ['tenant_id = $1'];
      const params = [tenantId];
      if (filter.status !== undefined) { params.push(filter.status); cond.push(`status = $${params.length}`); }
      if (filter.aiPaused !== undefined) { params.push(!!filter.aiPaused); cond.push(`ai_paused = $${params.length}`); }
      const { rows } = await q(
        `SELECT * FROM conversations WHERE ${cond.join(' AND ')} ORDER BY COALESCE(last_message_at, created_at) DESC`,
        params
      );
      return rows2obj(rows);
    },
    async update(tenantId, id, patch = {}) {
      const sets = [];
      const params = [tenantId, id];
      const add = (col, val, cast = '') => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };
      if ('status' in patch) add('status', patch.status);
      if ('aiPaused' in patch) add('ai_paused', !!patch.aiPaused);
      if ('lang' in patch) add('lang', patch.lang);
      if ('state' in patch) add('state', patch.state == null ? null : JSON.stringify(patch.state), '::jsonb');
      if ('lastMessageAt' in patch) add('last_message_at', patch.lastMessageAt);
      if (!sets.length) return this.getById(tenantId, id);
      const { rows } = await q(
        `UPDATE conversations SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        params
      );
      return row2obj(rows[0]);
    },
    async setStatus(tenantId, id, status) { return this.update(tenantId, id, { status }); },
    async setAiPaused(tenantId, id, aiPaused) { return this.update(tenantId, id, { aiPaused }); },
    async appendMessage(tenantId, conversationId, message = {}) {
      // INSERT..SELECT gated by tenant ownership: no row if the conversation is
      // not owned by tenantId -> cross-tenant append is impossible.
      const { rows } = await q(
        `INSERT INTO messages (conversation_id, tenant_id, direction, type, body, wa_message_id, status, ts)
         SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, COALESCE($8::timestamptz, now())
         WHERE EXISTS (SELECT 1 FROM conversations WHERE id = $1 AND tenant_id = $2)
         RETURNING *`,
        [
          conversationId, tenantId, message.direction || 'inbound', message.type || 'text',
          JSON.stringify(message.body ?? {}), message.waMessageId ?? null, message.status ?? null,
          message.ts ?? null,
        ]
      );
      if (!rows[0]) throw new Error('appendMessage: conversation not found for tenant');
      await q(
        'UPDATE conversations SET last_message_at = COALESCE($3::timestamptz, now()) WHERE id = $1 AND tenant_id = $2',
        [conversationId, tenantId, message.ts ?? null]
      );
      return row2obj(rows[0]);
    },
    async listMessages(tenantId, conversationId, { limit } = {}) {
      const params = [tenantId, conversationId];
      let sql;
      if (limit) {
        params.push(limit);
        sql = `SELECT * FROM (
                 SELECT * FROM messages WHERE tenant_id = $1 AND conversation_id = $2
                 ORDER BY ts DESC, seq DESC LIMIT $3
               ) s ORDER BY ts ASC, seq ASC`;
      } else {
        sql = `SELECT * FROM messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY ts ASC, seq ASC`;
      }
      const { rows } = await q(sql, params);
      return rows2obj(rows);
    },
  };

  const appointments = {
    async create(tenantId, data = {}) {
      const { rows } = await q(
        `INSERT INTO appointments
           (tenant_id, ref, conversation_id, patient_id, patient_wa_id, patient_name, specialty,
            specialty_label, datetime_iso, datetime_adjusted, origin_city, origin_country, origin_raw,
            contact, lang, channel, status, created_by, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
         RETURNING *`,
        [
          tenantId, data.ref ?? fallbackRef(), data.conversationId ?? null, data.patientId ?? null,
          data.patientWaId ?? null, data.patientName ?? null, data.specialty ?? null,
          data.specialtyLabel ?? null, data.datetimeIso ?? data.datetimeISO ?? null,
          data.datetimeAdjusted ?? false, data.originCity ?? null, data.originCountry ?? null,
          data.originRaw ?? null, data.contact ?? null, data.lang ?? null, data.channel ?? 'whatsapp',
          data.status ?? 'pending', data.createdBy ?? 'bot', JSON.stringify(data.meta ?? {}),
        ]
      );
      return row2obj(rows[0]);
    },
    async list(tenantId, filter = {}) {
      const cond = ['tenant_id = $1'];
      const params = [tenantId];
      if (filter.status !== undefined) { params.push(filter.status); cond.push(`status = $${params.length}`); }
      if (filter.patientWaId !== undefined) { params.push(filter.patientWaId); cond.push(`patient_wa_id = $${params.length}`); }
      if (filter.from !== undefined) { params.push(filter.from); cond.push(`datetime_iso >= $${params.length}`); }
      if (filter.to !== undefined) { params.push(filter.to); cond.push(`datetime_iso <= $${params.length}`); }
      const { rows } = await q(
        `SELECT * FROM appointments WHERE ${cond.join(' AND ')} ORDER BY datetime_iso NULLS LAST, created_at`,
        params
      );
      return rows2obj(rows);
    },
    async get(tenantId, id) {
      const { rows } = await q('SELECT * FROM appointments WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
      return row2obj(rows[0]);
    },
    async updateStatus(tenantId, id, status) {
      const { rows } = await q(
        'UPDATE appointments SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [tenantId, id, status]
      );
      return row2obj(rows[0]);
    },
  };

  const leads = {
    async create(tenantId, data = {}) {
      const { rows } = await q(
        `INSERT INTO leads
           (tenant_id, conversation_id, patient_id, patient_wa_id, procedure, origin_city,
            origin_country, budget_signal, status, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'new'),$10::jsonb)
         RETURNING *`,
        [
          tenantId, data.conversationId ?? null, data.patientId ?? null, data.patientWaId ?? null,
          data.procedure ?? null, data.originCity ?? null, data.originCountry ?? null,
          data.budgetSignal ?? null, data.status ?? null, JSON.stringify(data.details ?? {}),
        ]
      );
      return row2obj(rows[0]);
    },
    async list(tenantId, filter = {}) {
      const cond = ['tenant_id = $1'];
      const params = [tenantId];
      if (filter.status !== undefined) { params.push(filter.status); cond.push(`status = $${params.length}`); }
      const { rows } = await q(`SELECT * FROM leads WHERE ${cond.join(' AND ')} ORDER BY created_at DESC`, params);
      return rows2obj(rows);
    },
    async get(tenantId, id) {
      const { rows } = await q('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
      return row2obj(rows[0]);
    },
    async updateStatus(tenantId, id, status) {
      const { rows } = await q(
        'UPDATE leads SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [tenantId, id, status]
      );
      return row2obj(rows[0]);
    },
  };

  const kbEntries = {
    async list(tenantId, filter = {}) {
      const cond = ['tenant_id = $1'];
      const params = [tenantId];
      if (filter.status !== undefined) { params.push(filter.status); cond.push(`status = $${params.length}`); }
      const { rows } = await q(`SELECT * FROM kb_entries WHERE ${cond.join(' AND ')} ORDER BY key`, params);
      return rows2obj(rows);
    },
    async get(tenantId, key) {
      const { rows } = await q('SELECT * FROM kb_entries WHERE tenant_id = $1 AND key = $2', [tenantId, key]);
      return row2obj(rows[0]);
    },
    async upsert(tenantId, entry = {}) {
      if (!entry.key) throw new Error('kbEntries.upsert: key required');
      const { rows } = await q(
        `INSERT INTO kb_entries (tenant_id, key, question, answer, keywords, lang, source, status)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,COALESCE($7,'manual'),COALESCE($8,'active'))
         ON CONFLICT (tenant_id, key) DO UPDATE SET
           question = EXCLUDED.question, answer = EXCLUDED.answer, keywords = EXCLUDED.keywords,
           lang = EXCLUDED.lang, source = EXCLUDED.source, status = EXCLUDED.status
         RETURNING *`,
        [
          tenantId, entry.key, entry.question ?? null, JSON.stringify(entry.answer ?? {}),
          JSON.stringify(entry.keywords ?? []), entry.lang ?? null, entry.source ?? null, entry.status ?? null,
        ]
      );
      return row2obj(rows[0]);
    },
    async remove(tenantId, key) {
      const { rows } = await q(
        "UPDATE kb_entries SET status = 'archived' WHERE tenant_id = $1 AND key = $2 RETURNING *",
        [tenantId, key]
      );
      return row2obj(rows[0]);
    },
  };

  const events = {
    async append(tenantId, event = {}) {
      const { rows } = await q(
        `INSERT INTO events (tenant_id, type, actor, conversation_id, payload)
         VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
        [tenantId ?? null, event.type || 'unknown', event.actor ?? null, event.conversationId ?? null,
         JSON.stringify(event.payload ?? {})]
      );
      return row2obj(rows[0]);
    },
    async list(tenantId, filter = {}) {
      const cond = ['tenant_id = $1'];
      const params = [tenantId];
      if (filter.type !== undefined) { params.push(filter.type); cond.push(`type = $${params.length}`); }
      let sql = `SELECT * FROM events WHERE ${cond.join(' AND ')} ORDER BY id ASC`;
      if (filter.limit) {
        params.push(filter.limit);
        sql = `SELECT * FROM (SELECT * FROM events WHERE ${cond.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}) s ORDER BY id ASC`;
      }
      const { rows } = await q(sql, params);
      return rows2obj(rows);
    },
  };

  const notificationPrefs = {
    async list(tenantId) {
      const { rows } = await q('SELECT * FROM notification_prefs WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
      return rows2obj(rows);
    },
    async get(tenantId, recipient, channel = 'whatsapp') {
      const { rows } = await q(
        'SELECT * FROM notification_prefs WHERE tenant_id = $1 AND recipient = $2 AND channel = $3',
        [tenantId, recipient, channel]
      );
      return row2obj(rows[0]);
    },
    async upsert(tenantId, pref = {}) {
      if (!pref.recipient) throw new Error('notificationPrefs.upsert: recipient required');
      const { rows } = await q(
        `INSERT INTO notification_prefs (tenant_id, recipient, channel, role, events, quiet_hours, active)
         VALUES ($1,$2,COALESCE($3,'whatsapp'),$4,$5::jsonb,$6::jsonb,COALESCE($7,true))
         ON CONFLICT (tenant_id, recipient, channel) DO UPDATE SET
           role = EXCLUDED.role, events = EXCLUDED.events,
           quiet_hours = EXCLUDED.quiet_hours, active = EXCLUDED.active
         RETURNING *`,
        [
          tenantId, pref.recipient, pref.channel ?? null, pref.role ?? null,
          JSON.stringify(pref.events ?? {}), pref.quietHours != null ? JSON.stringify(pref.quietHours) : null,
          pref.active ?? null,
        ]
      );
      return row2obj(rows[0]);
    },
    async remove(tenantId, recipient, channel = 'whatsapp') {
      const { rows } = await q(
        'DELETE FROM notification_prefs WHERE tenant_id = $1 AND recipient = $2 AND channel = $3 RETURNING *',
        [tenantId, recipient, channel]
      );
      return row2obj(rows[0]);
    },
  };

  return {
    name: 'postgres',
    tenants,
    patients,
    conversations,
    appointments,
    leads,
    kbEntries,
    events,
    notificationPrefs,
    async health() {
      const { rows } = await q('SELECT 1 AS ok');
      return { ok: rows[0]?.ok === 1, adapter: 'postgres' };
    },
    async close() {
      await pool.end();
    },
  };
}
