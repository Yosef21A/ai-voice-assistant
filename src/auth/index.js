// Auth composition: the /api/auth router + requireAuth / requireRole middleware.
// Users live in the store's `users` collection; every request is tenant-scoped
// off the signed cookie's `tid` claim, re-validated against the live user row.
import express from 'express';
import { hashPassword, verifyPassword } from './passwords.js';
import {
  signSession,
  verifySession,
  parseCookies,
  serializeCookie,
  COOKIE_NAME,
} from './sessions.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 8;

const sanitizeUser = (u) =>
  u && {
    id: u.id,
    tenantId: u.tenantId,
    email: u.email,
    role: u.role,
    name: u.name ?? null,
    status: u.status,
    lastLoginAt: u.lastLoginAt ?? null,
  };

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {object} deps
 * @param {object} deps.store   the shared store instance
 * @param {object} deps.config  getConfig() output (sessionSecret, cookieSecure, sessionTtlMs)
 */
export function createAuth({ store, config }) {
  const secret = config.sessionSecret;
  const ttlMs = config.sessionTtlMs;
  const cookieOpts = { secure: !!config.cookieSecure, sameSite: 'Lax', httpOnly: true, path: '/' };

  function setSessionCookie(res, user) {
    const token = signSession({ uid: user.id, tid: user.tenantId, role: user.role }, secret, ttlMs);
    res.append(
      'Set-Cookie',
      serializeCookie(COOKIE_NAME, token, { ...cookieOpts, maxAge: Math.floor(ttlMs / 1000) })
    );
  }

  function clearSessionCookie(res) {
    res.append('Set-Cookie', serializeCookie(COOKIE_NAME, '', { ...cookieOpts, maxAge: 0 }));
  }

  // ── middleware ──────────────────────────────────────────────────────────────
  // Validates the cookie, loads the live user (so a disabled account is locked
  // out immediately), slides the 7d window, and attaches { user, tenantId }.
  const requireAuth = asyncHandler(async (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const claims = verifySession(token, secret);
    if (!claims) return res.status(401).json({ error: 'unauthenticated' });
    const user = await store.users.getById(claims.tid, claims.uid);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'unauthenticated' });
    req.user = user;
    req.tenantId = user.tenantId;
    setSessionCookie(res, user); // sliding expiry
    next();
  });

  // owner is a superset of staff: requireRole('staff') admits owners too.
  const requireRole = (role) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (req.user.role === role || req.user.role === 'owner') return next();
    return res.status(403).json({ error: 'forbidden', need: role });
  };

  // ── routes ──────────────────────────────────────────────────────────────────
  const router = express.Router();

  // Bootstrap the FIRST owner for a tenant. Rejected once that tenant already
  // has any user (per-tenant bootstrap; each clinic self-serves once).
  router.post(
    '/setup',
    asyncHandler(async (req, res) => {
      const { tenantId, email, password, name } = req.body || {};
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
      if (!EMAIL_RE.test(String(email || ''))) return res.status(400).json({ error: 'valid email required' });
      if (String(password || '').length < MIN_PASSWORD) {
        return res.status(400).json({ error: `password must be >= ${MIN_PASSWORD} chars` });
      }
      const tenant = await store.tenants.getById(tenantId);
      if (!tenant) return res.status(404).json({ error: 'unknown tenant' });
      if ((await store.users.countForTenant(tenantId)) > 0) {
        return res.status(409).json({ error: 'tenant already initialized' });
      }
      if (await store.users.getByEmail(email)) {
        return res.status(409).json({ error: 'email already registered' });
      }
      const passwordHash = await hashPassword(password);
      const user = await store.users.create(tenantId, { email, passwordHash, role: 'owner', name });
      setSessionCookie(res, user);
      res.status(201).json({ user: sanitizeUser(user) });
    })
  );

  // Brute-force gate (P2-F): 10 failures per (ip, email) per 15 min → 429.
  // In-memory is enough for the single-process pilot; success clears the slot.
  const loginFails = new Map(); // key -> { count, windowStart }
  const LOGIN_MAX_FAILS = 10;
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const loginKey = (req, email) => `${req.ip || req.socket?.remoteAddress || '?'}|${String(email || '').toLowerCase()}`;
  const loginBlocked = (key) => {
    const rec = loginFails.get(key);
    if (!rec) return false;
    if (Date.now() - rec.windowStart >= LOGIN_WINDOW_MS) {
      loginFails.delete(key);
      return false;
    }
    return rec.count >= LOGIN_MAX_FAILS;
  };
  const loginFailed = (key) => {
    const now = Date.now();
    const rec = loginFails.get(key);
    if (!rec || now - rec.windowStart >= LOGIN_WINDOW_MS) {
      loginFails.set(key, { count: 1, windowStart: now });
      if (loginFails.size > 5000) {
        for (const [k, v] of loginFails) if (now - v.windowStart >= LOGIN_WINDOW_MS) loginFails.delete(k);
      }
    } else {
      rec.count += 1;
    }
  };

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const { email, password } = req.body || {};
      const key = loginKey(req, email);
      if (loginBlocked(key)) {
        return res.status(429).json({ error: 'too many attempts — try again later' });
      }
      const user = await store.users.getByEmail(email);
      const ok = user && user.status === 'active' && (await verifyPassword(password, user.passwordHash));
      if (!ok) {
        loginFailed(key);
        return res.status(401).json({ error: 'invalid credentials' }); // no user enumeration
      }
      loginFails.delete(key);
      await store.users.touchLogin(user.tenantId, user.id);
      setSessionCookie(res, user);
      res.json({ user: sanitizeUser(user) });
    })
  );

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: sanitizeUser(req.user) });
  });

  return { router, requireAuth, requireRole, setSessionCookie, clearSessionCookie, sanitizeUser };
}

export default createAuth;
