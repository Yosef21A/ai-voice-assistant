// Thin fetch wrapper for the dashboard. Always sends the session cookie
// (credentials:'include'); a 401 from any call notifies the registered handler
// (AuthContext) so the app drops back to the login screen. Errors carry the HTTP
// status + parsed body so callers can branch (e.g. 409 -> "already set up").

let unauthorizedHandler = null;

/** AuthContext registers a callback invoked whenever a request returns 401. */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

function qs(params) {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function request(method, path, body) {
  const opts = { method, credentials: 'include', headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (networkErr) {
    const e = new Error('network');
    e.status = 0;
    e.cause = networkErr;
    throw e;
  }
  if (res.status === 401) {
    if (unauthorizedHandler) unauthorizedHandler();
    const e = new Error('unauthenticated');
    e.status = 401;
    throw e;
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = new Error((data && data.error) || res.statusText || 'request failed');
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

export const api = {
  raw: request,
  // ── auth ──────────────────────────────────────────────────────────────────
  me: () => request('GET', '/api/auth/me'),
  login: (body) => request('POST', '/api/auth/login', body),
  setup: (body) => request('POST', '/api/auth/setup', body),
  logout: () => request('POST', '/api/auth/logout'),
  // ── tenant ────────────────────────────────────────────────────────────────
  getTenant: () => request('GET', '/api/tenant'),
  putTenant: (patch) => request('PUT', '/api/tenant', patch),
  // ── knowledge base ─────────────────────────────────────────────────────────
  listKb: (params) => request('GET', `/api/kb${qs(params)}`),
  createKb: (body) => request('POST', '/api/kb', body),
  updateKb: (key, body) => request('PUT', `/api/kb/${encodeURIComponent(key)}`, body),
  deleteKb: (key) => request('DELETE', `/api/kb/${encodeURIComponent(key)}`),
  // ── conversations (live inbox) ──────────────────────────────────────────────
  listConversations: (params) => request('GET', `/api/conversations${qs(params)}`),
  getConversation: (id) => request('GET', `/api/conversations/${encodeURIComponent(id)}`),
  takeover: (id, paused) => request('POST', `/api/conversations/${encodeURIComponent(id)}/takeover`, { paused }),
  sendMessage: (id, text) => request('POST', `/api/conversations/${encodeURIComponent(id)}/send`, { text }),
  // ── appointments ────────────────────────────────────────────────────────────
  listAppointments: (params) => request('GET', `/api/appointments${qs(params)}`),
  setAppointmentStatus: (id, status) => request('POST', `/api/appointments/${encodeURIComponent(id)}/status`, { status }),
  // ── sandbox test-drive ──────────────────────────────────────────────────────
  sandboxMessage: (text) => request('POST', '/api/sandbox/message', { text }),
  sandboxReset: () => request('DELETE', '/api/sandbox'),
};

export default api;
