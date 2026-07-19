// Stateless sessions — HMAC-signed, tamper-evident tokens (no server store) plus
// a hand-rolled cookie parser/serializer (no cookie/cookie-parser dependency).
//
// Token layout:  base64url(payloadJSON) . base64url(HMAC-SHA256(payload, secret))
// Payload:       { uid, tid, role, iat, exp }   (seconds since epoch)
//
// Any byte flipped in the payload changes the required signature, and the compare
// is constant-time, so forged/edited cookies are rejected.
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'omen_session';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

function sign(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest();
}

/**
 * @param {{uid:string,tid:string,role:string}} claims
 * @param {string} secret
 * @param {number} ttlMs  session lifetime
 * @returns {string} signed token
 */
export function signSession(claims, secret, ttlMs) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.floor(ttlMs / 1000);
  const payload = { uid: claims.uid, tid: claims.tid, role: claims.role, iat, exp };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sigB64 = b64url(sign(payloadB64, secret));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify signature + expiry. Returns the claims or null. Never throws.
 * @param {string} token
 * @param {string} secret
 */
export function verifySession(token, secret) {
  try {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const expected = sign(payloadB64, secret);
    const got = fromB64url(sigB64);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const claims = JSON.parse(fromB64url(payloadB64).toString('utf8'));
    if (!claims || typeof claims !== 'object') return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Parse a raw `Cookie:` header into a plain object. */
export function parseCookies(header = '') {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Serialize a Set-Cookie value. `maxAge` is in seconds; 0 clears the cookie. */
export function serializeCookie(name, value, { maxAge, secure = false, sameSite = 'Lax', path = '/', httpOnly = true } = {}) {
  const segs = [`${name}=${encodeURIComponent(value)}`];
  segs.push(`Path=${path}`);
  if (httpOnly) segs.push('HttpOnly');
  segs.push(`SameSite=${sameSite}`);
  if (secure) segs.push('Secure');
  if (maxAge != null) {
    segs.push(`Max-Age=${maxAge}`);
    if (maxAge === 0) segs.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return segs.join('; ');
}

export { COOKIE_NAME };
