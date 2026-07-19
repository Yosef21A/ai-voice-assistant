// Error taxonomy for the outbound WhatsApp sender.
//
// Every failure a caller sees is one of these typed shapes, so downstream
// slices (inbox replies, notifications, reminders) can branch on `.type`
// (or `instanceof`) without ever parsing Graph error strings themselves.
//
// Retriability is a PROPERTY of the error, decided here from the Graph error
// code + HTTP status. The send loop then stays dumb: "retry while
// error.retriable && attempts remain".
//
// Graph / WhatsApp Cloud API error reference (subset we map):
//   190 / 0 / 3 / 10 / 200-299  -> auth / permission
//   4 / 80007 / 130429 / 131048 / 131056 / 133016 -> rate limiting
//   131047                      -> re-engagement required (24h window closed)
//   131030 / 131026            -> recipient cannot receive the message
//   HTTP 5xx / network / timeout -> transport (transient)

export class WhatsAppError extends Error {
  constructor(message, opts = {}) {
    super(message);
    const {
      type = 'WhatsAppError',
      code = 'invalid_request',
      status,
      graphCode,
      graphSubcode,
      retriable = false,
      retryAfter,
      details,
    } = opts;
    this.name = type;
    this.type = type;
    this.code = code;
    this.status = status;
    this.graphCode = graphCode;
    this.graphSubcode = graphSubcode;
    this.retriable = retriable;
    this.retryAfter = retryAfter; // milliseconds, when the server told us (rate limiting)
    this.details = details;
  }
}

// 401 / 403, bad or expired token, missing permission. Never retriable.
export class AuthError extends WhatsAppError {
  constructor(message, opts = {}) {
    super(message, { code: 'auth', ...opts, type: 'AuthError', retriable: false });
  }
}

// 429 or a Graph rate-limit code. Retriable, carries retryAfter when known.
export class RateLimited extends WhatsAppError {
  constructor(message, opts = {}) {
    super(message, { code: 'rate_limited', retriable: true, ...opts, type: 'RateLimited' });
  }
}

// Recipient not on WhatsApp / not in the allowed list / undeliverable. Logical.
export class InvalidRecipient extends WhatsAppError {
  constructor(message, opts = {}) {
    super(message, { code: 'invalid_recipient', ...opts, type: 'InvalidRecipient', retriable: false });
  }
}

// 131047: more than 24h since the customer's last message -> a plain text send
// is refused and an approved TEMPLATE must be used instead. Not retriable.
export class WindowExpired extends WhatsAppError {
  constructor(message, opts = {}) {
    super(message, { code: 'window_expired', ...opts, type: 'WindowExpired', retriable: false });
  }
}

// Network failure, timeout (AbortController) or HTTP 5xx. Transient -> retriable.
export class TransportError extends WhatsAppError {
  constructor(message, opts = {}) {
    super(message, { code: 'transport', retriable: true, ...opts, type: 'TransportError' });
  }
}

const AUTH_CODES = new Set([0, 3, 10, 190]);
const RATE_CODES = new Set([4, 80007, 130429, 131048, 131056, 133016]);
const RECIPIENT_CODES = new Set([131030, 131026]);
const WINDOW_CODES = new Set([131047]);

/**
 * Parse a Retry-After header into milliseconds (delta), supporting both the
 * "seconds" and the HTTP-date forms. Returns undefined when absent/unparseable.
 * @param {Headers|{get?:Function}} headers
 * @param {number} [nowMs]
 */
export function parseRetryAfter(headers, nowMs = Date.now()) {
  const raw =
    headers && typeof headers.get === 'function' ? headers.get('retry-after') : undefined;
  if (raw == null || raw === '') return undefined;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  return undefined;
}

/**
 * Map a Graph API error response to a typed WhatsAppError. Graph codes are
 * checked BEFORE the HTTP status, because WhatsApp frequently returns HTTP 400
 * for semantically distinct failures (rate limit, closed window, etc.).
 * @param {number} status  HTTP status
 * @param {object|null} json  parsed response body ({ error: { code, ... } })
 * @param {Headers} [headers]
 */
export function classifyHttpError(status, json, headers) {
  const g = (json && json.error) || {};
  const graphCode = typeof g.code === 'number' ? g.code : undefined;
  const graphSubcode = typeof g.error_subcode === 'number' ? g.error_subcode : undefined;
  const message = g.message || `WhatsApp API HTTP ${status}`;
  const retryAfter = parseRetryAfter(headers);
  const base = { status, graphCode, graphSubcode };

  if (graphCode !== undefined && WINDOW_CODES.has(graphCode)) {
    return new WindowExpired(message, base);
  }
  if (status === 429 || (graphCode !== undefined && RATE_CODES.has(graphCode))) {
    return new RateLimited(message, { ...base, retryAfter });
  }
  if (
    status === 401 ||
    status === 403 ||
    (graphCode !== undefined &&
      (AUTH_CODES.has(graphCode) || (graphCode >= 200 && graphCode <= 299)))
  ) {
    return new AuthError(message, base);
  }
  if (graphCode !== undefined && RECIPIENT_CODES.has(graphCode)) {
    return new InvalidRecipient(message, base);
  }
  if (status >= 500) {
    return new TransportError(message, { ...base, retriable: true });
  }
  // Any other 4xx is a logical error we must NOT retry.
  return new WhatsAppError(message, {
    ...base,
    type: 'WhatsAppError',
    code: 'invalid_request',
    retriable: false,
  });
}

/**
 * Map a thrown fetch/network error (incl. AbortController timeout) to a
 * retriable TransportError.
 */
export function classifyNetworkError(err) {
  const timeout = !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
  return new TransportError(
    timeout ? 'WhatsApp API request timed out' : err?.message || 'network error',
    { retriable: true, details: { reason: timeout ? 'timeout' : 'network', name: err?.name } }
  );
}

/** Serializable projection of an error for {ok:false,error} results + audit logs. */
export function toPlainError(err) {
  if (!err) return null;
  return {
    type: err.type || err.name || 'WhatsAppError',
    code: err.code || 'invalid_request',
    message: err.message,
    status: err.status,
    graphCode: err.graphCode,
    graphSubcode: err.graphSubcode,
    retriable: !!err.retriable,
    retryAfter: err.retryAfter,
  };
}
