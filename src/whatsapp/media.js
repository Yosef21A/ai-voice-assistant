// Inbound media downloader (P2-D) — the ONE place that pulls patient media
// (X-rays, documents, voice notes) off the WhatsApp Cloud API.
//
// Graph flow (real transport):
//   1. GET {apiBase}/{graphVersion}/{mediaId}   (Bearer)  → { url, mime_type, file_size }
//   2. GET that lookaside CDN url               (Bearer)  → binary (url expires ~5 min,
//      so the download happens synchronously in the webhook ingest, never lazily)
//
// Design mirrors src/whatsapp/sender.js on purpose:
//   - self-contained (own .env fallbacks; zero imports from the rest of src/),
//   - transport 'mock'|'real' gated by WHATSAPP_TRANSPORT / token presence, so
//     tests, simulate and the offline demo never touch the network,
//   - injectable fetchImpl/now/logger seams,
//   - structured never-throwing results: { ok, file?, mimeType?, size?, error? }.
//
// Safety (medical context, PRODUCT-SPEC §3.1/§3.3):
//   - mime-type ALLOWLIST decides the stored extension — sender filenames are
//     display metadata only, never touched for paths;
//   - size cap enforced twice: on the metadata file_size BEFORE downloading and
//     on the actual byte length after;
//   - files land under {mediaDir}/{tenantId}/{yyyymm}/{uuid}.{ext} — no client
//     input in any path segment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WhatsAppError, classifyHttpError, classifyNetworkError, toPlainError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_MEDIA_DIR = path.join(ROOT_DIR, 'data', 'media');

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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {
    /* env is entirely optional */
  }
}

// mime → stored extension. The allowlist IS the policy: anything else is refused.
// Voice notes arrive as 'audio/ogg; codecs=opus' — match on the bare type.
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
};
export const bareMime = (mime) => String(mime || '').split(';')[0].trim().toLowerCase();
export const allowedMime = (mime) => Object.hasOwn(MIME_EXT, bareMime(mime));

function resolveToken(tenant, fallback) {
  const t =
    tenant && typeof tenant === 'object'
      ? tenant.accessToken ?? tenant.token ?? tenant.whatsapp?.token ?? tenant.whatsapp?.accessToken
      : undefined;
  return t || fallback || '';
}

export class WhatsAppMediaClient {
  /**
   * @param {object} [options]
   * @param {string}   [options.token]        WHATSAPP_TOKEN override
   * @param {'real'|'mock'} [options.transport]
   * @param {string}   [options.graphVersion] default v23.0 (same chain as the sender)
   * @param {string}   [options.apiBase]
   * @param {string}   [options.mediaDir]     storage root (default data/media)
   * @param {number}   [options.maxBytes]     hard cap (default 10MB)
   * @param {number}   [options.timeoutMs]    per-request timeout (default 20000)
   * @param {Function} [options.fetchImpl]    inject fetch (tests)
   * @param {Function} [options.now]          inject clock
   * @param {Function} [options.logger]
   */
  constructor(options = {}) {
    loadDotEnvOnce();
    const env = process.env;
    const token = options.token ?? env.WHATSAPP_TOKEN ?? '';
    const explicit = options.transport ?? env.WHATSAPP_TRANSPORT;
    this.transport = explicit === 'mock' || explicit === 'real' ? explicit : token ? 'real' : 'mock';
    this.token = token;
    this.graphVersion = options.graphVersion || env.WHATSAPP_GRAPH_VERSION || 'v23.0';
    this.apiBase = (options.apiBase || env.WHATSAPP_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');
    this.mediaDir = options.mediaDir || env.MEDIA_DIR || DEFAULT_MEDIA_DIR;
    this.maxBytes = Number(options.maxBytes ?? env.MEDIA_MAX_BYTES) || 10 * 1024 * 1024;
    this.timeoutMs = Number(options.timeoutMs) || 20000;
    this._fetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : (u, o) => globalThis.fetch(u, o);
    this._now = typeof options.now === 'function' ? options.now : () => new Date();
    this._logger = typeof options.logger === 'function' ? options.logger : () => {};
  }

  /**
   * Download one inbound media object and store it on disk.
   * @param {object} tenant   tenant/clinic record (BYO token wins, like the sender)
   * @param {object} media    { id, mimeType } from the normalized webhook message
   * @returns {Promise<{ok:true, file:string, mimeType:string, size:number} |
   *                   {ok:false, error:object}>}  file is RELATIVE to mediaDir.
   */
  async fetchMedia(tenant, media = {}) {
    const tenantId = tenant?.id || tenant?.tenantId || 'unknown';
    const mediaId = media.id;
    if (!mediaId) return this._fail('media id missing');
    if (!allowedMime(media.mimeType)) {
      return this._fail(`mime type not allowed: ${bareMime(media.mimeType) || 'unknown'}`);
    }

    if (this.transport === 'mock') {
      // Offline/dev: store a tiny deterministic placeholder so the full
      // pipeline (paths, records, API route, UI) is exercised end-to-end.
      const mime = bareMime(media.mimeType);
      const rel = this._relPath(tenantId, mime);
      const abs = path.join(this.mediaDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const buf = Buffer.from(`mock-media:${mediaId}:${mime}`);
      fs.writeFileSync(abs, buf);
      return { ok: true, file: rel, mimeType: mime, size: buf.length };
    }

    const token = resolveToken(tenant, this.token);
    if (!token) return this._fail('no WhatsApp access token configured');

    try {
      // 1. metadata (also our chance to refuse oversize BEFORE moving bytes)
      const meta = await this._get(`${this.apiBase}/${this.graphVersion}/${mediaId}`, token, 'json');
      if (!meta.ok) return { ok: false, error: meta.error };
      const { url, mime_type: metaMime, file_size: fileSize } = meta.data || {};
      const mime = bareMime(metaMime || media.mimeType);
      if (!url) return this._fail('graph media metadata carried no url');
      if (!allowedMime(mime)) return this._fail(`mime type not allowed: ${mime}`);
      // FAIL CLOSED: a missing/non-numeric file_size must not slip past the cap.
      const declared = Number(fileSize);
      if (!Number.isFinite(declared) || declared > this.maxBytes) {
        return this._fail(`media too large or size unknown: ${fileSize} (cap ${this.maxBytes})`);
      }

      // 2. binary from the lookaside CDN (same Bearer token; url expires fast).
      // The read itself is byte-budgeted — a body larger than the declared size
      // (or gzip-inflated) aborts mid-stream instead of ballooning RAM.
      const bin = await this._get(url, token, 'bytes', this.maxBytes);
      if (!bin.ok) return { ok: false, error: bin.error };
      if (bin.data.length > this.maxBytes) {
        return this._fail(`media too large: ${bin.data.length} > ${this.maxBytes}`);
      }

      const rel = this._relPath(tenantId, mime);
      const abs = path.join(this.mediaDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bin.data);
      return { ok: true, file: rel, mimeType: mime, size: bin.data.length };
    } catch (e) {
      this._logger('media download failed', e?.message);
      return { ok: false, error: toPlainError(e instanceof WhatsAppError ? e : new WhatsAppError(String(e?.message || e))) };
    }
  }

  _relPath(tenantId, mime) {
    const d = this._now();
    const yyyymm = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    // Segments are server-generated only (tenant ids come from clinics.json).
    return path.join(String(tenantId), yyyymm, `${randomUUID()}.${MIME_EXT[bareMime(mime)]}`);
  }

  // Single bounded GET (one retry on retriable failures) returning json|bytes.
  // For 'bytes', `maxBytes` budgets the BODY READ itself: Content-Length is
  // checked first when present, then the stream is consumed chunk-by-chunk and
  // aborted the moment the budget trips — peak memory stays capped even if the
  // server lies about (or omits) the size, or the body inflates.
  async _get(url, token, kind, maxBytes = Infinity) {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      let res = null;
      let netErr = null;
      try {
        res = await this._fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
      } catch (e) {
        netErr = e;
      } finally {
        clearTimeout(timer);
      }

      if (netErr) {
        const error = classifyNetworkError(netErr);
        if (error.retriable && attempt < 1) continue;
        return { ok: false, error: toPlainError(error) };
      }
      if (!res.ok) {
        let json = null;
        try {
          json = JSON.parse(await res.text());
        } catch {
          json = null;
        }
        const error = classifyHttpError(res.status, json, res.headers);
        if (error.retriable && attempt < 1) continue;
        return { ok: false, error: toPlainError(error) };
      }
      if (kind === 'json') {
        try {
          return { ok: true, data: await res.json() };
        } catch {
          return { ok: false, error: toPlainError(new WhatsAppError('graph media metadata was not JSON')) };
        }
      }

      const tooLarge = (n) => ({
        ok: false,
        error: toPlainError(
          new WhatsAppError(`media too large: body exceeded ${n}`, { code: 'invalid_media', retriable: false })
        ),
      });
      const contentLength = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        controller.abort();
        return tooLarge(maxBytes);
      }
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength ?? value.length ?? 0;
          if (total > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              /* stream already dead */
            }
            controller.abort();
            return tooLarge(maxBytes);
          }
          chunks.push(Buffer.from(value));
        }
        return { ok: true, data: Buffer.concat(chunks) };
      }
      // Injected test stubs may not expose a web stream — fall back, the
      // caller's post-read length check still applies.
      return { ok: true, data: Buffer.from(await res.arrayBuffer()) };
    }
  }

  _fail(message) {
    return { ok: false, error: toPlainError(new WhatsAppError(message, { code: 'invalid_media', retriable: false })) };
  }
}

export function createMediaClient(options = {}) {
  return new WhatsAppMediaClient(options);
}

export default createMediaClient;
