// CRM sync v1 (V7) — lean and honest: per-tenant SIGNED outbound webhooks.
//
// The owner pastes a URL + secret in Settings; from then on appointment and
// lead events POST there as JSON, signed with HMAC-SHA256 over the exact body
// (header `X-Omen-Signature: sha256=<hex>`), so the receiver can verify both
// origin and integrity. Retries with backoff on failure; every attempt's
// outcome lands in the events audit log (`crm.delivery`). No Google OAuth
// in-product — docs/integrations.md shows the 10-minute Apps Script recipe
// that turns these webhooks into a live Google Sheet.
import crypto from 'node:crypto';

const EVENTS = [
  'appointment.created',
  'appointment.updated',
  'appointment.cancelled',
  'lead.hot',
  'lead.updated',
];
const TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 5000];

export function signBody(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(body, 'utf8').digest('hex');
}

/** Strip payloads down to CRM-relevant fields (never raw transcripts). */
function crmPayload(type, envelope) {
  if (type.startsWith('appointment.')) {
    const a = envelope.appointment || {};
    return {
      id: a.id ?? null,
      ref: a.ref ?? null,
      status: a.status ?? null,
      specialty: a.specialty ?? null,
      specialtyLabel: a.specialtyLabel ?? null,
      datetimeIso: a.datetimeISO ?? a.datetimeIso ?? null,
      patientName: a.patientName ?? null,
      patientWaId: a.patientWaId ?? null,
      contact: a.contact ?? null,
      originCity: a.originCity ?? null,
      originCountry: a.originCountry ?? null,
      lang: a.lang ?? null,
    };
  }
  const l = envelope.lead || {};
  return {
    id: l.id ?? null,
    reason: l.reason ?? null,
    procedure: l.procedure ?? null,
    status: l.status ?? null,
    originCountry: l.country ?? l.originCountry ?? null,
    patientWaId: l.patientWaId ?? null,
    conversationId: l.conversationId ?? envelope.conversationId ?? null,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.bus
 * @param {object} deps.store       (events audit + clinic config reads)
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.sleep]
 * @param {Function} [deps.logger]
 */
export function createCrmSync({ bus, store, fetchImpl, sleep, logger } = {}) {
  if (!bus) throw new Error('createCrmSync: bus is required');
  if (!store) throw new Error('createCrmSync: store is required');
  const doFetch = fetchImpl || ((url, opts) => globalThis.fetch(url, opts));
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = typeof logger === 'function' ? logger : () => {};
  const subscriptions = [];
  const inflight = new Set();

  function crmConfig(tenantId) {
    const clinic = typeof store.getClinicById === 'function' ? store.getClinicById(tenantId) : null;
    const crm = clinic?.crm;
    if (!crm || typeof crm !== 'object') return null;
    const url = String(crm.webhookUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    return { url, secret: String(crm.secret || '') };
  }

  async function deliver(type, envelope) {
    const tenantId = envelope?.tenantId;
    if (!tenantId) return;
    const cfg = crmConfig(tenantId);
    if (!cfg) return; // CRM sync not configured for this tenant — free no-op

    const body = JSON.stringify({
      event: type,
      tenantId,
      at: new Date().toISOString(),
      data: crmPayload(type, envelope),
    });
    const signature = signBody(cfg.secret, body);

    let ok = false;
    let lastStatus = null;
    let attempt = 0;
    for (; attempt < MAX_ATTEMPTS && !ok; attempt++) {
      if (attempt > 0) await wait(BACKOFF_MS[attempt - 1] ?? 5000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        const res = await doFetch(cfg.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Omen-Signature': signature,
            'X-Omen-Event': type,
          },
          body,
          signal: controller.signal,
        });
        lastStatus = res.status;
        // 2xx = delivered; 4xx = the receiver rejects it — retrying won't help.
        ok = res.status >= 200 && res.status < 300;
        if (!ok && res.status >= 400 && res.status < 500) break;
      } catch (e) {
        lastStatus = null; // network/timeout — retriable
        log('crm delivery attempt failed', type, e?.message);
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      await store.events.append(tenantId, {
        type: 'crm.delivery',
        actor: 'crm',
        conversationId: envelope.conversationId ?? null,
        payload: { event: type, ok, status: lastStatus, attempts: attempt },
      });
    } catch {
      /* audit is best-effort */
    }
  }

  for (const type of EVENTS) {
    const handler = (envelope) => {
      const p = deliver(type, envelope || {})
        .catch((e) => log('crm delivery failed', type, e?.message))
        .finally(() => inflight.delete(p));
      inflight.add(p);
    };
    bus.on(type, handler);
    subscriptions.push([type, handler]);
  }

  return {
    stop() {
      for (const [type, handler] of subscriptions.splice(0)) bus.off(type, handler);
    },
    /** Await all in-flight deliveries (tests / graceful shutdown). */
    async settled() {
      await Promise.allSettled([...inflight]);
    },
  };
}

export default createCrmSync;
