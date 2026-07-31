// The ONE outbound gateway to the WhatsApp Calling API (`/{PHONE_NUMBER_ID}/calls`).
//
// Deliberately the same shape as src/whatsapp/sender.js — same transport gating
// (real | mock, auto-selected from the token), same typed error taxonomy
// (src/whatsapp/errors.js), same never-throw contract: every failure comes back
// as { ok: false, error } so a Graph hiccup can never take a call handler down.
// Two differences, both intentional:
//
//   1. ONE retry only. A send can be retried for eight seconds and still be
//      useful; a `pre_accept` cannot — Meta's answer window is ~30-60s and the
//      caller is listening to a ring tone the whole time. Late is the same as
//      never, so we try twice and give up loudly.
//   2. Recorded actions instead of an outbox file. Calls carry no message id and
//      no transcript row of their own; the in-memory `recorded` ring is what the
//      tests and the local harness assert on.
//
// Verified contract (G0, 2026-07-31):
//   POST {apiBase}/{version}/{phoneNumberId}/calls
//   { messaging_product:'whatsapp', call_id, action, session?, biz_opaque_callback_data? }
//   action: 'pre_accept' | 'accept' (both carry session {sdp_type:'answer', sdp})
//         | 'reject' | 'terminate' (no session)
//   → 200 { "success": true }   |   Graph error { error: { message, type, code } }
import {
  WhatsAppError,
  AuthError,
  classifyHttpError,
  classifyNetworkError,
  toPlainError,
} from '../whatsapp/errors.js';

const ACTIONS = new Set(['pre_accept', 'accept', 'reject', 'terminate']);
const RECORDED_CAP = 200;
const DEFAULT_TIMEOUT_MS = 10000;

// Accept a clinic record, a future tenants row, or a bare phone_number_id —
// identical resolution order to the sender so tenants never behave differently
// on calls than they do on messages.
function resolvePhoneNumberId(tenant) {
  if (tenant == null) return undefined;
  if (typeof tenant === 'string' || typeof tenant === 'number') return String(tenant);
  const v =
    tenant.phone_number_id ??
    tenant.phoneNumberId ??
    tenant.whatsapp?.phoneNumberId ??
    tenant.whatsapp?.phone_number_id;
  return v != null && v !== '' ? String(v) : undefined;
}

function resolveToken(tenant, fallback) {
  const t =
    tenant && typeof tenant === 'object'
      ? tenant.accessToken ?? tenant.token ?? tenant.whatsapp?.token ?? tenant.whatsapp?.accessToken
      : undefined;
  return t || fallback || '';
}

function resolveTenantId(tenant) {
  if (!tenant || typeof tenant !== 'object') return null;
  return tenant.id ?? tenant.tenantId ?? tenant.clinicId ?? null;
}

/**
 * @param {object} [options]
 * @param {'real'|'mock'} [options.transport] default: token present ⇒ real
 * @param {string} [options.token]            default WHATSAPP_TOKEN
 * @param {string} [options.apiBase]          VOICE_CALL_GRAPH_BASE | WHATSAPP_API_BASE
 * @param {string} [options.graphVersion]     WHATSAPP_GRAPH_VERSION | v23.0
 * @param {number} [options.timeoutMs]        per-request timeout (default 10000)
 * @param {(rec:object)=>any} [options.onAction] mock-only hook (harness/tests)
 * @param {(rec:object)=>any} [options.onResult] fires for BOTH transports
 * @param {Function} [options.fetchImpl]      inject fetch (tests)
 * @param {Function} [options.sleep]          inject sleep (tests)
 * @param {Function} [options.now]            inject clock (tests)
 * @param {Function} [options.logger]         inject logger (default: silent)
 */
export function createGraphCalls(options = {}) {
  const env = process.env;
  // `options.token` WINS over the environment (nullish-coalescing, so an
  // explicit '' means "no token"). src/server.js passes config.whatsappToken so
  // the composed app has exactly ONE source of truth for credentials — reading
  // process.env here as well is what let a developer's .env leak into a test.
  const token = options.token ?? env.WHATSAPP_TOKEN ?? '';
  const explicit = options.transport ?? env.VOICE_CALL_TRANSPORT;
  // Only the two recognized literals force a transport. Anything else (typo,
  // 'REAL', 'production', '') falls through to the token auto-rule — it must
  // never be treated as an opt-in to hitting Graph. Same semantics as
  // src/whatsapp/sender.js, deliberately, so one mental model covers both.
  const transport =
    explicit === 'real' ? 'real' : explicit === 'mock' ? 'mock' : token ? 'real' : 'mock';

  // Same "config wins over env" rule as the token: if the caller PASSED an
  // apiBase — including an empty string, which means "use the Graph default" —
  // the environment is not consulted at all. `|| env…` would have let a
  // developer's VOICE_CALL_GRAPH_BASE (the harness URL) survive into a composed
  // test app even after the config pinned it away.
  const baseFromCaller =
    options.apiBase !== undefined
      ? options.apiBase
      : env.VOICE_CALL_GRAPH_BASE || env.WHATSAPP_API_BASE || '';
  const apiBase = String(baseFromCaller || 'https://graph.facebook.com').replace(/\/+$/, '');
  const graphVersion = options.graphVersion || env.WHATSAPP_GRAPH_VERSION || 'v23.0';
  const timeoutMs = Number(options.timeoutMs ?? env.VOICE_CALL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const doFetch =
    typeof options.fetchImpl === 'function'
      ? options.fetchImpl
      : (url, opts) => globalThis.fetch(url, opts);
  const sleep =
    typeof options.sleep === 'function' ? options.sleep : (msec) => new Promise((r) => setTimeout(r, msec));
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const logger = typeof options.logger === 'function' ? options.logger : () => {};

  const recorded = [];

  // SDP is multi-kilobyte and carries the caller's IP candidates: it is NEVER
  // stored, only flagged present. Same reason we never log a raw Graph token.
  function record(rec) {
    recorded.push(rec);
    if (recorded.length > RECORDED_CAP) recorded.splice(0, recorded.length - RECORDED_CAP);
    if (transport === 'mock' && typeof options.onAction === 'function') {
      try {
        options.onAction(rec);
      } catch (e) {
        logger('voice-call onAction hook failed', e?.message);
      }
    }
    if (typeof options.onResult === 'function') {
      try {
        options.onResult(rec);
      } catch (e) {
        logger('voice-call onResult hook failed', e?.message);
      }
    }
    return rec;
  }

  function build(action, callId, tenant, phoneNumberId, sdp, outcome) {
    return {
      at: now().toISOString(),
      transport,
      action,
      callId: callId != null ? String(callId) : null,
      tenantId: resolveTenantId(tenant),
      phoneNumberId: phoneNumberId ?? null,
      sdp: sdp ? '<sdp>' : null,
      ok: !!outcome.ok,
      error: outcome.error || null,
    };
  }

  function fail(action, callId, tenant, phoneNumberId, sdp, err) {
    const error = toPlainError(err);
    record(build(action, callId, tenant, phoneNumberId, sdp, { ok: false, error }));
    return { ok: false, error };
  }

  /**
   * Execute one call action. Never throws.
   * @param {object} p
   * @param {object|string} p.tenant  clinic record (or a bare phone_number_id)
   * @param {string} p.callId         Meta's `wacid.…`
   * @param {'pre_accept'|'accept'|'reject'|'terminate'} p.action
   * @param {string} [p.sdp]          our SDP answer (pre_accept / accept only)
   * @param {string} [p.sdpType]      default 'answer'
   * @param {string} [p.opaqueData]   biz_opaque_callback_data (echoed back by Meta)
   * @returns {Promise<{ok:boolean, error?:object}>}
   */
  async function callAction({ tenant, callId, action, sdp, sdpType, opaqueData } = {}) {
    const phoneNumberId = resolvePhoneNumberId(tenant);
    if (!ACTIONS.has(action)) {
      return fail(
        action || 'unknown',
        callId,
        tenant,
        phoneNumberId ?? null,
        sdp,
        new WhatsAppError(`unsupported call action: ${action}`, { code: 'invalid_request' })
      );
    }
    if (!callId) {
      return fail(
        action,
        null,
        tenant,
        phoneNumberId ?? null,
        sdp,
        new WhatsAppError('callAction requires a call_id', { code: 'invalid_request' })
      );
    }
    if (!phoneNumberId) {
      return fail(
        action,
        callId,
        tenant,
        null,
        sdp,
        new WhatsAppError('tenant is missing a phone_number_id', { code: 'invalid_request' })
      );
    }

    const payload = { messaging_product: 'whatsapp', call_id: String(callId), action };
    if (sdp) payload.session = { sdp_type: sdpType || 'answer', sdp: String(sdp) };
    if (opaqueData) payload.biz_opaque_callback_data = String(opaqueData);

    // MOCK: no network, no sockets. The harness and every test live here.
    if (transport === 'mock') {
      record(build(action, callId, tenant, phoneNumberId, sdp, { ok: true }));
      return { ok: true };
    }

    const accessToken = resolveToken(tenant, token);
    if (!accessToken) {
      return fail(
        action,
        callId,
        tenant,
        phoneNumberId,
        sdp,
        new AuthError('no WhatsApp access token configured (set WHATSAPP_TOKEN)')
      );
    }

    const url = `${apiBase}/${graphVersion}/${phoneNumberId}/calls`;
    const outcome = await post(url, accessToken, payload);
    record(build(action, callId, tenant, phoneNumberId, sdp, outcome));
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
  }

  // At most TWO attempts. See the header: a late pre_accept is a dropped call.
  async function post(url, accessToken, payload) {
    const body = JSON.stringify(payload);
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      let res = null;
      let netErr = null;
      try {
        res = await doFetch(url, { method: 'POST', headers, body, signal: controller.signal });
      } catch (e) {
        netErr = e;
      } finally {
        clearTimeout(timer);
      }

      let error;
      if (netErr) {
        error = classifyNetworkError(netErr);
      } else {
        let json = null;
        try {
          const raw = await res.text();
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        if (res.ok && !(json && json.error)) return { ok: true };
        error = classifyHttpError(res.status, json, res.headers);
      }

      if (error.retriable && attempt < 1) {
        await sleep(Math.min(error.retryAfter ?? 300, 1000));
        continue;
      }
      logger('voice-call action failed', error.type, error.message);
      return { ok: false, error: toPlainError(error) };
    }
  }

  return { callAction, transport, apiBase, graphVersion, recorded };
}

export default createGraphCalls;
