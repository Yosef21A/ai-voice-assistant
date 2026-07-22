// The ONE outbound gateway to the WhatsApp Cloud API (Graph).
//
// Design goals (P1-B):
//   - Single place that talks to Graph: text / template / media / buttons / read.
//   - Transport-agnostic core: a REAL transport (global fetch, Node 18+/22) and a
//     MOCK transport (no network, records to data/runtime/outbox.json) selected by
//     WHATSAPP_TRANSPORT or the presence of a token -> full offline dev/demo/test.
//   - Reliability: per-request timeout (AbortController), bounded retries with
//     exponential backoff + jitter on 429/5xx/network, NO retry on 4xx logical
//     errors; a typed error taxonomy (see ./errors.js).
//   - Structured, never-throwing results: { ok, waMessageId?, error? }.
//   - Persistence hook: an optional onOutbound(record) callback lets a future
//     slice log every send to the messages table. This module NEVER imports the
//     store (safe while src/store is being refactored concurrently).
//
// It stays transport-agnostic in spirit: sendEngineReply() adapts the engine's
// reply payload (the same shape server.js / simulate.js consume) into concrete
// sends, so callers hand it an engine result and it does the right thing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WhatsAppError,
  AuthError,
  classifyHttpError,
  classifyNetworkError,
  toPlainError,
} from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const RUNTIME_DIR = path.join(ROOT_DIR, 'data', 'runtime');
const DEFAULT_OUTBOX = path.join(RUNTIME_DIR, 'outbox.json');

// Tiny, idempotent .env loader — mirrors src/config.js (only sets keys that are
// not already defined, so real environment variables always win). Kept LOCAL so
// this module has zero imports from the rest of src/ during the store refactor.
let _envLoaded = false;
function loadDotEnvOnce() {
  if (_envLoaded) return;
  _envLoaded = true;
  try {
    const envPath = path.join(ROOT_DIR, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {
    /* env is entirely optional */
  }
}

const MEDIA_TYPES = new Set(['image', 'document', 'video', 'audio', 'sticker']);
const CAPTIONABLE = new Set(['image', 'video', 'document']);
const MAX_BUTTONS = 3;
const BUTTON_TITLE_MAX = 20; // WhatsApp reply-button title limit
const BUTTON_ID_MAX = 256;

// ── tenant helpers (accept clinic records, the future tenants row, or a bare id)
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
  if (!tenant || typeof tenant !== 'object') return undefined;
  return tenant.id ?? tenant.tenantId ?? tenant.clinicId ?? undefined;
}

// Normalize loose button inputs ({id,title} | {payload,label} | "String") into
// WhatsApp reply-button shape, enforcing the id/title length limits.
function normalizeButtons(buttons) {
  const arr = Array.isArray(buttons) ? buttons : [];
  return arr.map((b, i) => {
    if (b && typeof b === 'object') {
      const id = String(b.id ?? b.payload ?? b.value ?? `btn_${i + 1}`).slice(0, BUTTON_ID_MAX);
      const title = String(b.title ?? b.label ?? b.text ?? id).slice(0, BUTTON_TITLE_MAX);
      return { id, title };
    }
    // A bare string is a display label: keep the text as the title and give it a
    // stable, positional id (btn_1, btn_2, …) for the inbound router to match on.
    const s = String(b ?? '');
    return {
      id: `btn_${i + 1}`,
      title: (s || `btn_${i + 1}`).slice(0, BUTTON_TITLE_MAX),
    };
  });
}

export class WhatsAppSender {
  /**
   * @param {object} [options]
   * @param {string}   [options.token]         WHATSAPP_TOKEN override
   * @param {'real'|'mock'} [options.transport] force a transport (default: env / token)
   * @param {string}   [options.graphVersion]  default v23.0
   * @param {string}   [options.apiBase]       default https://graph.facebook.com
   * @param {number}   [options.timeoutMs]     per-request timeout (default 15000)
   * @param {number}   [options.maxRetries]    retries on 429/5xx/network (default 3)
   * @param {number}   [options.retryBaseMs]   backoff base (default 500)
   * @param {number}   [options.retryMaxMs]    backoff cap (default 8000)
   * @param {string}   [options.outboxFile]    mock outbox path (default data/runtime/outbox.json)
   * @param {(record:object)=>any} [options.onOutbound] persistence hook (both transports)
   * @param {Function} [options.fetchImpl]     inject fetch (tests); defaults to global fetch
   * @param {Function} [options.sleep]         inject sleep (tests)
   * @param {Function} [options.randomFn]      inject jitter source (tests)
   * @param {Function} [options.now]           inject clock (tests)
   * @param {Function} [options.logger]        inject logger (default: silent)
   */
  constructor(options = {}) {
    loadDotEnvOnce();
    const env = process.env;

    const token = options.token ?? env.WHATSAPP_TOKEN ?? '';
    const explicit = options.transport ?? env.WHATSAPP_TRANSPORT;
    this.transport =
      explicit === 'mock' || explicit === 'real' ? explicit : token ? 'real' : 'mock';
    this.token = token;

    this.graphVersion = options.graphVersion || env.WHATSAPP_GRAPH_VERSION || 'v23.0';
    this.apiBase = (options.apiBase || env.WHATSAPP_API_BASE || 'https://graph.facebook.com').replace(
      /\/+$/,
      ''
    );
    this.timeoutMs = Number(options.timeoutMs ?? env.WHATSAPP_TIMEOUT_MS) || 15000;
    this.maxRetries = Number.isFinite(options.maxRetries)
      ? options.maxRetries
      : Number(env.WHATSAPP_MAX_RETRIES) || 3;
    this.retryBaseMs = Number(options.retryBaseMs) || 500;
    this.retryMaxMs = Number(options.retryMaxMs) || 8000;

    this.outboxFile = options.outboxFile || DEFAULT_OUTBOX;
    this.onOutbound = typeof options.onOutbound === 'function' ? options.onOutbound : null;

    // Humanized inter-bubble delays (P2-HUMANIZE §3): ON only for the real
    // transport by default — tests/simulate on mock stay instant. The delay is
    // min(1.2s + chars/60, 4s) per bubble, matching a human typing rhythm.
    this.humanizeDelays =
      typeof options.humanizeDelays === 'boolean'
        ? options.humanizeDelays
        : this.transport === 'real';

    // Injectable seams — real defaults, overridable in tests / future ports.
    this._fetch =
      typeof options.fetchImpl === 'function'
        ? options.fetchImpl
        : (url, opts) => globalThis.fetch(url, opts);
    this._sleep =
      typeof options.sleep === 'function'
        ? options.sleep
        : (ms) => new Promise((r) => setTimeout(r, ms));
    this._random = typeof options.randomFn === 'function' ? options.randomFn : Math.random;
    this._now = typeof options.now === 'function' ? options.now : () => new Date();
    this._logger = typeof options.logger === 'function' ? options.logger : () => {};
    this._seq = 0;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /** Free-form text (only valid inside the 24h service window). */
  async sendText(tenant, toWaId, text, opts = {}) {
    if (text == null || String(text) === '') {
      return this._reject('text', tenant, toWaId, 'sendText requires non-empty text');
    }
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(toWaId),
      type: 'text',
      text: { body: String(text), preview_url: !!opts.previewUrl },
    };
    return this._send('text', tenant, toWaId, payload);
  }

  /** Pre-approved template message (the only thing allowed outside the window). */
  async sendTemplate(tenant, toWaId, templateName, lang, components) {
    if (!templateName) {
      return this._reject('template', tenant, toWaId, 'sendTemplate requires a templateName');
    }
    const code = typeof lang === 'string' && lang ? lang : lang?.code || 'en';
    const template = { name: String(templateName), language: { code } };
    if (Array.isArray(components) && components.length) template.components = components;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(toWaId),
      type: 'template',
      template,
    };
    return this._send('template', tenant, toWaId, payload);
  }

  /**
   * Media message. `idOrLink` is auto-detected: an http(s) URL becomes a link,
   * anything else is treated as a pre-uploaded Media ID.
   * @param {object} media { type, idOrLink, caption?, filename? }
   */
  async sendMedia(tenant, toWaId, media = {}) {
    const { type, idOrLink, caption, filename } = media;
    if (!MEDIA_TYPES.has(type)) {
      return this._reject(
        'media',
        tenant,
        toWaId,
        `sendMedia type must be one of: ${[...MEDIA_TYPES].join(', ')}`
      );
    }
    if (!idOrLink) return this._reject('media', tenant, toWaId, 'sendMedia requires idOrLink');
    const obj = /^https?:\/\//i.test(String(idOrLink))
      ? { link: String(idOrLink) }
      : { id: String(idOrLink) };
    if (caption && CAPTIONABLE.has(type)) obj.caption = String(caption);
    if (filename && type === 'document') obj.filename = String(filename);
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(toWaId),
      type,
      [type]: obj,
    };
    return this._send('media', tenant, toWaId, payload);
  }

  /** Interactive reply buttons (max 3). Buttons may be {id,title} or strings. */
  async sendButtons(tenant, toWaId, bodyText, buttons) {
    const norm = normalizeButtons(buttons);
    if (norm.length === 0) {
      return this._reject('buttons', tenant, toWaId, 'sendButtons requires at least one button');
    }
    if (norm.length > MAX_BUTTONS) {
      return this._reject(
        'buttons',
        tenant,
        toWaId,
        `sendButtons supports at most ${MAX_BUTTONS} reply buttons`
      );
    }
    if (bodyText == null || String(bodyText) === '') {
      return this._reject('buttons', tenant, toWaId, 'sendButtons requires body text');
    }
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(toWaId),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(bodyText) },
        action: {
          buttons: norm.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
        },
      },
    };
    return this._send('buttons', tenant, toWaId, payload);
  }

  /**
   * Mark an inbound message as read (blue ticks). Returns { ok } (no message id).
   * With opts.typing the same call also shows the typing indicator (Cloud API
   * piggybacks it on the read receipt; it auto-clears when a reply arrives or
   * after ~25s). Degrades silently — a failure never blocks the reply.
   */
  async markRead(tenant, waMessageId, opts = {}) {
    if (!waMessageId) return this._reject('read', tenant, null, 'markRead requires a message id');
    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: String(waMessageId),
    };
    if (opts.typing) payload.typing_indicator = { type: 'text' };
    return this._send('read', tenant, null, payload);
  }

  /**
   * Adapter for the engine's reply payload (same shape server.js / simulate.js
   * consume). Dispatches text now; if the reply DECLARES quick options
   * (`buttons` | `quickReplies` | `options` | `actions`), the final line is sent
   * as interactive reply buttons. Accepts a plain string too.
   * @returns {{ok:boolean, results:object[], waMessageId?:string, error?:object}}
   */
  async sendEngineReply(tenant, toWaId, reply) {
    const results = [];
    const push = async (p) => {
      const r = await p;
      results.push(r);
      return r;
    };

    if (reply == null) {
      return { ok: false, results, error: toPlainError(new WhatsAppError('empty engine reply')) };
    }
    if (typeof reply === 'string') {
      await push(this.sendText(tenant, toWaId, reply));
      return this._engineResult(results);
    }

    const norm = normalizeButtons(
      reply.buttons || reply.quickReplies || reply.options || reply.actions
    );
    let messages =
      Array.isArray(reply.replies) && reply.replies.length
        ? reply.replies.slice()
        : reply.reply != null && String(reply.reply) !== ''
          ? [String(reply.reply)]
          : [];
    if (messages.length === 0 && (reply.bodyText || reply.text)) {
      messages = [String(reply.bodyText || reply.text)];
    }

    if (norm.length > 0) {
      const body = messages.pop() ?? String(reply.bodyText ?? reply.reply ?? '');
      for (const m of messages) {
        await this._humanPause(m);
        await push(this.sendText(tenant, toWaId, m));
      }
      await this._humanPause(body);
      await push(this.sendButtons(tenant, toWaId, body, norm.slice(0, MAX_BUTTONS)));
    } else {
      if (messages.length === 0) {
        return {
          ok: false,
          results,
          error: toPlainError(new WhatsAppError('engine reply carried no text')),
        };
      }
      for (const m of messages) {
        await this._humanPause(m);
        await push(this.sendText(tenant, toWaId, m));
      }
    }
    return this._engineResult(results);
  }

  /** Humanized pre-bubble pause: min(1.2s + chars/60, 4s); no-op when disabled. */
  async _humanPause(text) {
    if (!this.humanizeDelays) return;
    const ms = Math.min(1.2 + String(text ?? '').length / 60, 4) * 1000;
    await this._sleep(ms);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  _engineResult(results) {
    const ok = results.length > 0 && results.every((r) => r && r.ok);
    const last = [...results].reverse().find((r) => r && r.waMessageId);
    const out = { ok, results };
    if (last) out.waMessageId = last.waMessageId;
    if (!ok) {
      const failed = results.find((r) => r && r.error);
      out.error = (failed && failed.error) || toPlainError(new WhatsAppError('send failed'));
    }
    return out;
  }

  // Validation failure -> audited, structured rejection (never throws, no fetch).
  async _reject(kind, tenant, toWaId, message) {
    const err = new WhatsAppError(message, { code: 'invalid_request', retriable: false });
    const record = this._buildRecord(kind, tenant, toWaId, null, {
      ok: false,
      error: toPlainError(err),
    });
    await this._emit(record);
    return { ok: false, error: toPlainError(err) };
  }

  _buildRecord(kind, tenant, toWaId, payload, outcome) {
    return {
      at: this._now().toISOString(),
      transport: this.transport,
      kind,
      tenantId: resolveTenantId(tenant) ?? null,
      phoneNumberId: resolvePhoneNumberId(tenant) ?? null,
      to: toWaId != null ? String(toWaId) : null,
      payload: payload || null,
      ok: !!outcome.ok,
      waMessageId: outcome.waMessageId || null,
      error: outcome.error || null,
    };
  }

  // Mock transport persists to the outbox file; the onOutbound hook fires for
  // BOTH transports (future slices point it at the messages table). Neither is
  // ever allowed to throw and break a send.
  async _emit(record) {
    if (this.transport === 'mock') {
      try {
        this._appendOutbox(record);
      } catch (e) {
        this._logger('whatsapp outbox write failed', e?.message);
      }
    }
    if (this.onOutbound) {
      try {
        await this.onOutbound(record);
      } catch (e) {
        this._logger('whatsapp onOutbound hook failed', e?.message);
      }
    }
  }

  _appendOutbox(record) {
    fs.mkdirSync(path.dirname(this.outboxFile), { recursive: true });
    let arr = [];
    try {
      if (fs.existsSync(this.outboxFile)) {
        arr = JSON.parse(fs.readFileSync(this.outboxFile, 'utf8')) || [];
      }
    } catch {
      arr = [];
    }
    if (!Array.isArray(arr)) arr = [];
    arr.push(record);
    fs.writeFileSync(this.outboxFile, JSON.stringify(arr, null, 2));
  }

  _mockId() {
    this._seq += 1;
    return `wamid.MOCK-${Date.now().toString(36)}-${this._seq}`;
  }

  async _send(kind, tenant, toWaId, payload) {
    const phoneNumberId = resolvePhoneNumberId(tenant);
    if (!phoneNumberId) {
      const err = new WhatsAppError('tenant is missing a phone_number_id', {
        code: 'invalid_request',
      });
      const record = this._buildRecord(kind, tenant, toWaId, payload, {
        ok: false,
        error: toPlainError(err),
      });
      await this._emit(record);
      return { ok: false, error: toPlainError(err) };
    }

    // MOCK: no network. Record the exact payload + return a fake message id.
    if (this.transport === 'mock') {
      const waMessageId = kind === 'read' ? null : this._mockId();
      const record = this._buildRecord(kind, tenant, toWaId, payload, { ok: true, waMessageId });
      await this._emit(record);
      return waMessageId ? { ok: true, waMessageId } : { ok: true };
    }

    // REAL: requires a token (tenant BYO token wins over the env default).
    const token = resolveToken(tenant, this.token);
    if (!token) {
      const err = new AuthError('no WhatsApp access token configured (set WHATSAPP_TOKEN)');
      const record = this._buildRecord(kind, tenant, toWaId, payload, {
        ok: false,
        error: toPlainError(err),
      });
      await this._emit(record);
      return { ok: false, error: toPlainError(err) };
    }

    const url = `${this.apiBase}/${this.graphVersion}/${phoneNumberId}/messages`;
    const outcome = await this._fetchWithRetry(url, token, payload);
    const record = this._buildRecord(kind, tenant, toWaId, payload, outcome);
    await this._emit(record);
    if (outcome.ok) {
      return outcome.waMessageId ? { ok: true, waMessageId: outcome.waMessageId } : { ok: true };
    }
    return { ok: false, error: outcome.error };
  }

  async _fetchWithRetry(url, token, payload) {
    const body = JSON.stringify(payload);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    let attempt = 0; // total attempts = maxRetries + 1

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      let res = null;
      let netErr = null;
      try {
        res = await this._fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      } catch (e) {
        netErr = e;
      } finally {
        clearTimeout(timer);
      }

      if (netErr) {
        const error = classifyNetworkError(netErr);
        if (error.retriable && attempt < this.maxRetries) {
          await this._backoff(attempt, null);
          attempt += 1;
          continue;
        }
        this._logger('whatsapp send failed', error.type, error.message);
        return { ok: false, error: toPlainError(error) };
      }

      let json = null;
      try {
        const raw = await res.text();
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }

      if (res.ok && !(json && json.error)) {
        const waMessageId = json && json.messages && json.messages[0] && json.messages[0].id;
        return { ok: true, waMessageId: waMessageId || null };
      }

      const error = classifyHttpError(res.status, json, res.headers);
      if (error.retriable && attempt < this.maxRetries) {
        await this._backoff(attempt, error.retryAfter);
        attempt += 1;
        continue;
      }
      this._logger('whatsapp send failed', error.type, error.message);
      return { ok: false, error: toPlainError(error) };
    }
  }

  // Exponential backoff with equal jitter. A server Retry-After (ms) is honored
  // verbatim; otherwise: capped(base * 2^attempt), half fixed + half random.
  async _backoff(attempt, retryAfterMs) {
    let delay;
    if (retryAfterMs != null) {
      delay = retryAfterMs;
    } else {
      const capped = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** attempt);
      delay = capped / 2 + this._random() * (capped / 2);
    }
    delay = Math.round(delay);
    await this._sleep(delay);
    return delay;
  }
}

/**
 * Factory — the ergonomic entrypoint. Reads env for any unspecified option, so
 * `createSender()` alone yields a working offline (mock) sender.
 * @param {object} [options] see WhatsAppSender constructor
 */
export function createSender(options = {}) {
  return new WhatsAppSender(options);
}

export default createSender;
