// One EventSource for the whole app (GET /api/stream, same-origin so the session
// cookie rides along). Auto-reconnects with capped backoff. Components subscribe
// to named domain events via useStreamEvent(type, handler) — the handler is kept
// in a ref so re-renders never churn the subscription.
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

const TYPES = [
  'message.in',
  'message.out',
  'conversation.updated',
  'appointment.created',
  'appointment.updated',
  'handoff.requested',
  'lead.hot',
  'lead.updated',
  'emergency.detected',
  'media.received',
  'kb.unanswered',
];

const EventStreamContext = createContext(null);

export function EventStreamProvider({ enabled, children }) {
  const listeners = useRef(new Map()); // type -> Set<fn>
  const [connected, setConnected] = useState(false);

  const subscribe = useCallback((type, fn) => {
    let set = listeners.current.get(type);
    if (!set) {
      set = new Set();
      listeners.current.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let es;
    let closed = false;
    let retry = 1000;
    let timer;

    const dispatch = (type) => (e) => {
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch {
        data = null;
      }
      const set = listeners.current.get(type);
      if (set) for (const fn of set) fn(data);
    };

    const connect = () => {
      es = new EventSource('/api/stream', { withCredentials: true });
      es.onopen = () => {
        setConnected(true);
        retry = 1000;
      };
      es.onerror = () => {
        setConnected(false);
        try {
          es.close();
        } catch {
          /* ignore */
        }
        if (!closed) {
          timer = setTimeout(connect, retry);
          retry = Math.min(retry * 2, 15000);
        }
      };
      for (const type of TYPES) es.addEventListener(type, dispatch(type));
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      if (es) es.close();
      setConnected(false);
    };
  }, [enabled]);

  return (
    <EventStreamContext.Provider value={{ subscribe, connected }}>
      {children}
    </EventStreamContext.Provider>
  );
}

export const useEventStream = () => useContext(EventStreamContext);

/** Subscribe to a single SSE event type for the lifetime of the component. */
export function useStreamEvent(type, handler) {
  const ctx = useContext(EventStreamContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!ctx) return undefined;
    return ctx.subscribe(type, (data) => ref.current(data));
  }, [ctx, type]);
}
