// JSON file-backed storage adapter — the zero-config DEFAULT.
//
// It implements BOTH:
//   1. the LEGACY synchronous engine surface (listClinics/getConversation/
//      saveConversation/createAppointment/…), preserved byte-for-byte so the
//      existing engine and its 17 tests never change; and
//   2. the ASYNC collection interface documented in src/store/README.md, shared
//      with the Postgres adapter (tenants, patients, conversations, messages,
//      appointments, leads, kbEntries, events, notificationPrefs).
//
// Persistence is plain JSON files under runtimeDir — single-process only (see
// deploy/RUNBOOK.md). The Postgres adapter lifts that constraint. The two
// surfaces share one in-memory `db`, so nothing diverges.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const COLLECTIONS = [
  'patients', 'conversations', 'messages', 'appointments',
  'leads', 'kb_entries', 'events', 'notification_prefs', 'tenants', 'users',
];

/**
 * @param {object} opts
 * @param {string} opts.clinicsFile  path to data/clinics.json (read-only seed)
 * @param {string} opts.runtimeDir   directory for persisted collections
 * @param {boolean} [opts.reset]     wipe the runtime dir first (tests/simulate)
 * @param {number} [opts.eventsMax]  ring-buffer cap on the events audit log
 */
export function createJsonStore({ clinicsFile, runtimeDir, reset = false, eventsMax = 10000 } = {}) {
  if (!runtimeDir) throw new Error('createJsonStore: runtimeDir is required');
  mkdirSync(runtimeDir, { recursive: true });

  const files = Object.fromEntries(
    COLLECTIONS.map((c) => [c, path.join(runtimeDir, `${c}.json`)])
  );

  // reset wipes persisted collections (tests / simulate). rmSync is preferred,
  // but some filesystems (e.g. certain FUSE / network mounts) forbid unlink;
  // fall back to truncating each collection file in place so reset still works.
  if (reset) {
    try {
      rmSync(runtimeDir, { recursive: true, force: true });
      mkdirSync(runtimeDir, { recursive: true });
    } catch {
      mkdirSync(runtimeDir, { recursive: true });
      for (const c of COLLECTIONS) {
        try {
          writeFileSync(files[c], '[]');
        } catch {
          /* ignore — best effort */
        }
      }
    }
  }

  const clinics =
    clinicsFile && existsSync(clinicsFile)
      ? JSON.parse(readFileSync(clinicsFile, 'utf8')).clinics
      : [];
  const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []);
  const db = Object.fromEntries(COLLECTIONS.map((c) => [c, read(files[c])]));
  // events is the high-churn collection (one row per patient message since
  // P2-A) — written compact; everything else stays pretty for debuggability.
  const persist = (name) =>
    writeFileSync(
      files[name],
      name === 'events' ? JSON.stringify(db[name]) : JSON.stringify(db[name], null, 2)
    );
  const now = () => new Date().toISOString();
  const fallbackRef = () =>
    `REF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

  // ══ 1. LEGACY synchronous engine surface (unchanged behavior) ═════════════
  const listClinics = () => clinics;
  const getClinicById = (id) => clinics.find((c) => c.id === id) || null;
  const getClinicByPhoneNumberId = (pnid) =>
    pnid ? clinics.find((c) => c.whatsapp?.phoneNumberId === String(pnid)) || null : null;
  const getDefaultClinic = () => clinics[0];

  function upsertPatient(clinicId, waId, patch = {}) {
    let p = db.patients.find((x) => x.clinicId === clinicId && x.waId === waId);
    if (!p) {
      p = { id: `pat_${clinicId}_${waId}`, clinicId, waId, createdAt: now() };
      db.patients.push(p);
    }
    Object.assign(p, patch);
    persist('patients');
    return p;
  }

  const convoId = (clinicId, waId) => `${clinicId}:${waId}`;
  const getConversation = (clinicId, waId) =>
    db.conversations.find((c) => c.id === convoId(clinicId, waId)) || null;
  function newConversation(clinicId, waId) {
    const convo = {
      id: convoId(clinicId, waId),
      clinicId,
      waId,
      lang: null,
      state: null,
      status: 'open',
      aiPaused: false,
      messages: [],
      createdAt: now(),
      updatedAt: now(),
    };
    db.conversations.push(convo);
    return convo;
  }
  function saveConversation(convo) {
    const idx = db.conversations.findIndex((c) => c.id === convo.id);
    if (idx === -1) db.conversations.push(convo);
    else db.conversations[idx] = convo;
    persist('conversations');
    return convo;
  }

  function createAppointment(appt) {
    db.appointments.push(appt);
    persist('appointments');
    return appt;
  }
  function listAppointments(filter = {}) {
    return db.appointments.filter((a) =>
      Object.entries(filter).every(([k, v]) => a[k] === v)
    );
  }

  // ══ 2. ASYNC collection interface (shared with Postgres) ══════════════════
  function tenantFromClinic(c) {
    return {
      id: c.id,
      phoneNumberId: c.whatsapp?.phoneNumberId ?? null,
      name: c.name,
      city: c.city ?? null,
      country: c.country ?? null,
      timezone: c.timezone ?? null,
      currency: c.currency ?? null,
      languages: c.languages ?? [],
      config: c,
      status: 'active',
    };
  }
  function allTenants() {
    const map = new Map(clinics.map((c) => [c.id, tenantFromClinic(c)]));
    for (const t of db.tenants) map.set(t.id, { ...(map.get(t.id) || {}), ...t });
    return [...map.values()];
  }
  const tenants = {
    async list() {
      return allTenants();
    },
    async getById(id) {
      return allTenants().find((t) => t.id === id) || null;
    },
    async getByPhoneNumberId(pnid) {
      if (pnid == null) return null;
      return allTenants().find((t) => String(t.phoneNumberId) === String(pnid)) || null;
    },
    async upsert(tenant) {
      if (!tenant?.id) throw new Error('tenants.upsert: id required');
      const idx = db.tenants.findIndex((t) => t.id === tenant.id);
      const prev = idx >= 0 ? db.tenants[idx] : { createdAt: now() };
      const rec = { status: 'active', languages: [], config: {}, ...prev, ...tenant, updatedAt: now() };
      if (idx === -1) db.tenants.push(rec);
      else db.tenants[idx] = rec;
      persist('tenants');
      return this.getById(tenant.id);
    },
  };

  const patients = {
    async upsert(tenantId, waId, patch = {}) {
      return upsertPatient(tenantId, waId, patch);
    },
    async get(tenantId, waId) {
      return db.patients.find((p) => p.clinicId === tenantId && p.waId === waId) || null;
    },
    async list(tenantId) {
      return db.patients.filter((p) => p.clinicId === tenantId);
    },
  };

  const conversations = {
    async get(tenantId, patientWaId) {
      return getConversation(tenantId, patientWaId);
    },
    async getById(tenantId, id) {
      return db.conversations.find((c) => c.id === id && c.clinicId === tenantId) || null;
    },
    async create(tenantId, { patientWaId, lang = null, status = 'open', aiPaused = false, state = null } = {}) {
      const existing = getConversation(tenantId, patientWaId);
      if (existing) return existing;
      const convo = newConversation(tenantId, patientWaId);
      convo.lang = lang;
      convo.status = status;
      convo.aiPaused = aiPaused;
      convo.state = state;
      saveConversation(convo);
      return convo;
    },
    async list(tenantId, filter = {}) {
      return db.conversations.filter(
        (c) =>
          c.clinicId === tenantId &&
          (filter.status === undefined || c.status === filter.status) &&
          (filter.aiPaused === undefined || !!c.aiPaused === !!filter.aiPaused)
      );
    },
    async update(tenantId, id, patch = {}) {
      const c = db.conversations.find((x) => x.id === id && x.clinicId === tenantId);
      if (!c) return null;
      for (const k of ['status', 'aiPaused', 'lang', 'state', 'lastMessageAt']) {
        if (k in patch) c[k] = patch[k];
      }
      c.updatedAt = now();
      persist('conversations');
      return c;
    },
    async setStatus(tenantId, id, status) {
      return this.update(tenantId, id, { status });
    },
    async setAiPaused(tenantId, id, aiPaused) {
      return this.update(tenantId, id, { aiPaused });
    },
    async appendMessage(tenantId, conversationId, message = {}) {
      const c = db.conversations.find((x) => x.id === conversationId && x.clinicId === tenantId);
      if (!c) throw new Error('appendMessage: conversation not found for tenant');
      const seq = (db.messages.length ? Math.max(...db.messages.map((m) => m.seq || 0)) : 0) + 1;
      const rec = {
        id: randomUUID(),
        seq,
        conversationId,
        tenantId,
        direction: message.direction || 'inbound',
        type: message.type || 'text',
        body: message.body ?? {},
        waMessageId: message.waMessageId ?? null,
        status: message.status ?? null,
        ts: message.ts || now(),
        createdAt: now(),
      };
      db.messages.push(rec);
      persist('messages');
      c.lastMessageAt = rec.ts;
      c.updatedAt = now();
      persist('conversations');
      return rec;
    },
    async listMessages(tenantId, conversationId, { limit } = {}) {
      let rows = db.messages
        .filter((m) => m.conversationId === conversationId && m.tenantId === tenantId)
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.seq || 0) - (b.seq || 0)));
      if (limit) rows = rows.slice(-limit);
      return rows;
    },
    // Hard-delete a conversation, its messages AND its events (sandbox reset +
    // GDPR erase — message.analyzed events carry raw patient snippets, so an
    // erase that leaves them behind is not an erase).
    // Tenant-scoped: a cross-tenant id never matches, so it can't delete B's rows.
    async remove(tenantId, id) {
      const idx = db.conversations.findIndex((c) => c.id === id && c.clinicId === tenantId);
      if (idx === -1) return null;
      const [rec] = db.conversations.splice(idx, 1);
      db.messages = db.messages.filter((m) => !(m.conversationId === id && m.tenantId === tenantId));
      db.events = db.events.filter((e) => !(e.conversationId === id && e.tenantId === tenantId));
      persist('conversations');
      persist('messages');
      persist('events');
      return rec;
    },
  };

  const appointments = {
    async create(tenantId, data = {}) {
      const appt = {
        ...data,
        id: data.id || randomUUID(),
        tenantId,
        clinicId: tenantId, // legacy listAppointments() compatibility
        ref: data.ref || fallbackRef(),
        status: data.status || 'pending',
        createdBy: data.createdBy || 'bot',
        channel: data.channel || 'whatsapp',
        datetimeAdjusted: !!data.datetimeAdjusted,
        createdAt: data.createdAt || now(),
        updatedAt: now(),
      };
      db.appointments.push(appt);
      persist('appointments');
      return appt;
    },
    async list(tenantId, filter = {}) {
      return db.appointments.filter(
        (a) =>
          (a.tenantId ?? a.clinicId) === tenantId &&
          (filter.status === undefined || a.status === filter.status) &&
          (filter.patientWaId === undefined || a.patientWaId === filter.patientWaId)
      );
    },
    async get(tenantId, id) {
      return db.appointments.find((a) => a.id === id && (a.tenantId ?? a.clinicId) === tenantId) || null;
    },
    async updateStatus(tenantId, id, status) {
      const a = db.appointments.find((x) => x.id === id && (x.tenantId ?? x.clinicId) === tenantId);
      if (!a) return null;
      a.status = status;
      a.updatedAt = now();
      persist('appointments');
      return a;
    },
  };

  const leads = {
    async create(tenantId, data = {}) {
      const lead = {
        ...data,
        id: data.id || randomUUID(),
        tenantId,
        status: data.status || 'new',
        details: data.details ?? {},
        createdAt: data.createdAt || now(),
        updatedAt: now(),
      };
      db.leads.push(lead);
      persist('leads');
      return lead;
    },
    async list(tenantId, filter = {}) {
      return db.leads.filter(
        (l) => l.tenantId === tenantId && (filter.status === undefined || l.status === filter.status)
      );
    },
    async get(tenantId, id) {
      return db.leads.find((l) => l.id === id && l.tenantId === tenantId) || null;
    },
    async updateStatus(tenantId, id, status) {
      const l = db.leads.find((x) => x.id === id && x.tenantId === tenantId);
      if (!l) return null;
      l.status = status;
      l.updatedAt = now();
      persist('leads');
      return l;
    },
  };

  const kbEntries = {
    async list(tenantId, filter = {}) {
      return db.kb_entries.filter(
        (k) => k.tenantId === tenantId && (filter.status === undefined || k.status === filter.status)
      );
    },
    async get(tenantId, key) {
      return db.kb_entries.find((k) => k.tenantId === tenantId && k.key === key) || null;
    },
    async upsert(tenantId, entry = {}) {
      if (!entry.key) throw new Error('kbEntries.upsert: key required');
      const idx = db.kb_entries.findIndex((k) => k.tenantId === tenantId && k.key === entry.key);
      const base =
        idx >= 0
          ? db.kb_entries[idx]
          : { id: randomUUID(), tenantId, key: entry.key, source: 'manual', status: 'active', createdAt: now() };
      const rec = { ...base, ...entry, tenantId, key: entry.key, updatedAt: now() };
      if (idx === -1) db.kb_entries.push(rec);
      else db.kb_entries[idx] = rec;
      persist('kb_entries');
      return rec;
    },
    async remove(tenantId, key) {
      const k = db.kb_entries.find((x) => x.tenantId === tenantId && x.key === key);
      if (!k) return null;
      k.status = 'archived';
      k.updatedAt = now();
      persist('kb_entries');
      return k;
    },
  };

  let eventSeq = db.events.length ? Math.max(...db.events.map((e) => e.id || 0)) : 0;
  const events = {
    async append(tenantId, event = {}) {
      const rec = {
        id: ++eventSeq,
        tenantId: tenantId ?? null,
        type: event.type || 'unknown',
        actor: event.actor ?? null,
        conversationId: event.conversationId ?? null,
        payload: event.payload ?? {},
        createdAt: now(),
      };
      db.events.push(rec);
      // Ring buffer: P2-A appends one event per patient message and persist()
      // rewrites the whole file synchronously — without a cap the reply path
      // slows down forever. Postgres keeps full history (no cap there).
      if (db.events.length > eventsMax) db.events.splice(0, db.events.length - eventsMax);
      persist('events');
      return rec;
    },
    async list(tenantId, filter = {}) {
      let rows = db.events
        .filter((e) => e.tenantId === tenantId && (filter.type === undefined || e.type === filter.type))
        .sort((a, b) => (a.id || 0) - (b.id || 0));
      if (filter.limit) rows = rows.slice(-filter.limit);
      return rows;
    },
  };

  const notificationPrefs = {
    async list(tenantId) {
      return db.notification_prefs.filter((n) => n.tenantId === tenantId);
    },
    async get(tenantId, recipient, channel = 'whatsapp') {
      return (
        db.notification_prefs.find(
          (n) => n.tenantId === tenantId && n.recipient === recipient && n.channel === channel
        ) || null
      );
    },
    async upsert(tenantId, pref = {}) {
      if (!pref.recipient) throw new Error('notificationPrefs.upsert: recipient required');
      const channel = pref.channel || 'whatsapp';
      const idx = db.notification_prefs.findIndex(
        (n) => n.tenantId === tenantId && n.recipient === pref.recipient && n.channel === channel
      );
      const base =
        idx >= 0
          ? db.notification_prefs[idx]
          : { id: randomUUID(), tenantId, events: {}, active: true, createdAt: now() };
      const rec = { ...base, ...pref, tenantId, channel, updatedAt: now() };
      if (idx === -1) db.notification_prefs.push(rec);
      else db.notification_prefs[idx] = rec;
      persist('notification_prefs');
      return rec;
    },
    async remove(tenantId, recipient, channel = 'whatsapp') {
      const idx = db.notification_prefs.findIndex(
        (n) => n.tenantId === tenantId && n.recipient === recipient && n.channel === channel
      );
      if (idx === -1) return null;
      const [rec] = db.notification_prefs.splice(idx, 1);
      persist('notification_prefs');
      return rec;
    },
  };

  // ── users (dashboard logins) ──────────────────────────────────────────────
  // Added in P1-C. Email is globally unique (lower-cased); every other read is
  // tenant-scoped. Passwords are hashed by src/auth before they reach here.
  const users = {
    async create(tenantId, { email, passwordHash, role = 'owner', name = null, status = 'active' } = {}) {
      if (!email) throw new Error('users.create: email required');
      const emailLower = String(email).toLowerCase();
      if (db.users.some((u) => u.emailLower === emailLower)) {
        throw new Error('users.create: email already exists');
      }
      const rec = {
        id: randomUUID(),
        tenantId,
        email: String(email),
        emailLower,
        passwordHash: passwordHash || null,
        role,
        name,
        status,
        lastLoginAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      db.users.push(rec);
      persist('users');
      return rec;
    },
    async getByEmail(email) {
      if (!email) return null;
      return db.users.find((u) => u.emailLower === String(email).toLowerCase()) || null;
    },
    async getById(tenantId, id) {
      return db.users.find((u) => u.id === id && u.tenantId === tenantId) || null;
    },
    async list(tenantId) {
      return db.users.filter((u) => u.tenantId === tenantId);
    },
    async countForTenant(tenantId) {
      return db.users.filter((u) => u.tenantId === tenantId).length;
    },
    async count() {
      return db.users.length;
    },
    async touchLogin(tenantId, id) {
      const u = db.users.find((x) => x.id === id && x.tenantId === tenantId);
      if (!u) return null;
      u.lastLoginAt = now();
      u.updatedAt = now();
      persist('users');
      return u;
    },
  };

  return {
    name: 'json',
    // legacy synchronous engine surface
    listClinics,
    getClinicById,
    getClinicByPhoneNumberId,
    getDefaultClinic,
    upsertPatient,
    getConversation,
    newConversation,
    saveConversation,
    createAppointment,
    listAppointments,
    // async collection interface
    tenants,
    users,
    patients,
    conversations,
    appointments,
    leads,
    kbEntries,
    events,
    notificationPrefs,
    async health() {
      return { ok: true, adapter: 'json', runtimeDir };
    },
    async close() {
      /* JSON store holds no external resources */
    },
  };
}
