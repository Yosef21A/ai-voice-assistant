// The shared socket discipline for every streaming-STT vendor: ONE WebSocket,
// ONE ready gate, ONE close path, and an emitter that never throws into a
// handler. Deepgram and Speechmatics speak different JSON but the same shape of
// conversation — open, announce yourself, stream binary audio, read transcripts
// — so the parts that are easy to get subtly wrong live here exactly once.
//
// THREE THINGS THAT ARE LOAD-BEARING:
//
//  1. THE READY GATE. Audio sent before the vendor has acknowledged the session
//     is audio the vendor is entitled to drop — or to close the socket over.
//     `ready` is a promise that settles exactly once; the chain above buffers
//     until it resolves and fails over the moment it rejects.
//  2. AUTH THAT WORKS IN BOTH RUNTIMES. Node 22's global WebSocket is the
//     browser constructor: it accepts SUBPROTOCOLS and no headers at all. Both
//     vendors support a header, and Deepgram also supports the `['token', key]`
//     subprotocol. So both are handed to the factory: the default (global)
//     implementation uses the subprotocol, and a deployment that injects `ws`
//     gets the header too. Stating that here is cheaper than discovering it on
//     a live call.
//  3. NOTHING THROWS OUT OF A HANDLER. A protocol surprise becomes an 'error'
//     event and a close, because the layer above has a real degrade path (the
//     next adapter, and ultimately the patient's own WhatsApp thread) and an
//     exception would skip all of it.
//
// Fully injectable: `wsFactory` is how the whole tier is tested without ever
// opening a socket, which is the hermeticity law of this repo.

const DEFAULT_READY_TIMEOUT_MS = 5000;

/**
 * @param {object} p
 * @param {string} p.url
 * @param {string} p.provider              for log lines and error messages
 * @param {string[]} [p.protocols]         WebSocket subprotocols (Deepgram auth)
 * @param {object} [p.headers]             for an injected `ws`-style factory
 * @param {Function} [p.wsFactory]         (url, { protocols, headers }) => WebSocket-like
 * @param {Function} [p.onOpen]            (session) — send the vendor's hello here
 * @param {Function} [p.onMessage]         (data, session) — raw frame body
 * @param {Function} [p.logger]
 * @param {number} [p.readyTimeoutMs]
 * @returns {{ready:Promise<boolean>, markReady:Function, fail:Function,
 *   send:Function, close:Function, on:Function, emit:Function, isOpen:Function,
 *   stats:Function}}
 */
export function createSocketSession({
  url,
  provider = 'stt',
  protocols,
  headers,
  wsFactory,
  onOpen,
  onMessage,
  logger,
  readyTimeoutMs,
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  const makeWs =
    typeof wsFactory === 'function'
      ? wsFactory
      : (u, opts) =>
          opts?.protocols?.length ? new globalThis.WebSocket(u, opts.protocols) : new globalThis.WebSocket(u);
  const readyMs = Number(readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS;

  const handlers = new Map();
  const state = { open: false, ready: false, closed: false, sent: 0, received: 0, bytesOut: 0 };
  let readyTimer = null;
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // Nobody may be awaiting this yet (the chain attaches a tick later); an
  // unhandled rejection here would take the whole process down over a socket.
  ready.catch(() => {});

  function emit(event, payload) {
    const list = handlers.get(event);
    if (!list) return;
    for (const cb of [...list]) {
      try {
        cb(payload);
      } catch (err) {
        log(`[voice-cascade] ${provider} handler threw:`, err?.message || err);
      }
    }
  }

  function clearReadyTimer() {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  function markReady() {
    if (settled) return;
    settled = true;
    state.ready = true;
    clearReadyTimer();
    resolveReady(true);
  }

  function fail(err) {
    const error = err instanceof Error ? err : new Error(String(err || `${provider} session failed`));
    if (!settled) {
      settled = true;
      clearReadyTimer();
      rejectReady(error);
    }
    emit('error', error);
  }

  let ws = null;
  const session = {
    ready,
    markReady,
    fail,
    on(event, cb) {
      if (typeof cb !== 'function') return () => {};
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(cb);
      return () => {
        const list = handlers.get(event) || [];
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      };
    },
    emit,
    isOpen: () => state.open && !state.closed,
    /** JSON or binary; never throws, returns false when it could not go out. */
    send(payload) {
      if (!ws || state.closed || !state.open) return false;
      try {
        if (typeof payload === 'string') ws.send(payload);
        else if (payload && typeof payload === 'object' && !ArrayBuffer.isView(payload) && !(payload instanceof ArrayBuffer)) {
          ws.send(JSON.stringify(payload));
        } else {
          ws.send(payload);
          state.bytesOut += payload?.byteLength || payload?.length || 0;
        }
        state.sent += 1;
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    stats() {
      return { ...state };
    },
    /** Idempotent, never throws. */
    close(reason) {
      if (state.closed) {
        clearReadyTimer();
        return;
      }
      state.closed = true;
      state.open = false;
      clearReadyTimer();
      if (!settled) {
        settled = true;
        rejectReady(new Error(`${provider} session closed locally${reason ? ` (${reason})` : ''}`));
      }
      try {
        ws?.close?.();
      } catch {
        /* best-effort */
      }
    },
  };

  try {
    ws = makeWs(url, { protocols, headers });
  } catch (err) {
    fail(err);
    return session;
  }

  if (ws) {
    ws.onopen = () => {
      state.open = true;
      try {
        onOpen?.(session);
      } catch (err) {
        fail(err);
      }
    };
    ws.onmessage = (ev) => {
      state.received += 1;
      try {
        onMessage?.(ev?.data ?? ev, session);
      } catch (err) {
        // A single malformed frame is not worth a dropped call: report it and
        // keep reading. The ready gate above is what decides failover.
        log(`[voice-cascade] ${provider} frame failed:`, err?.message || err);
      }
    };
    ws.onerror = (ev) => {
      fail(ev instanceof Error ? ev : new Error(ev?.message || `${provider} socket error`));
    };
    ws.onclose = (ev) => {
      state.open = false;
      const wasReady = state.ready;
      state.closed = true;
      clearReadyTimer();
      if (!settled) {
        settled = true;
        rejectReady(new Error(`${provider} socket closed before it was ready (${ev?.code ?? 'n/a'})`));
      }
      emit('close', { code: ev?.code ?? null, reason: ev?.reason ?? null, wasReady });
    };
    readyTimer = setTimeout(() => fail(new Error(`${provider} did not start within ${readyMs}ms`)), readyMs);
    readyTimer.unref?.();
  }

  return session;
}

/** Decode a frame body (string / Blob / Buffer / ArrayBuffer) into an object. */
export async function frameToObject(data) {
  if (data == null) return null;
  if (typeof data === 'string') return JSON.parse(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return JSON.parse(await data.text());
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8'));
  if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString('utf8'));
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
  }
  if (typeof data === 'object') return data; // a fake transport hands us the object
  return JSON.parse(String(data));
}

export default createSocketSession;
