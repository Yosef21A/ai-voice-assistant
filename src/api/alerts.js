// System alerts (P2-F): the owner-visible surface for silent failures.
//
// Two chronic ones motivated this module (both bit the pilot already):
//   wa_token_expired — the ~24h test-number token dies, every send 401s, and
//                      the owner sees a "working" bot that answers nobody.
//   llm_degraded     — the free Gemini tier exhausts its daily quota, the
//                      engine silently falls back to classic mode, and the bot
//                      just gets "dumber" with no visible cause.
//
// fire() throttles per (tenant, kind) so a burst of failures becomes ONE
// dashboard toast (SSE `system.alert`) + ONE audit event per window. The
// in-process `recent` snapshot also feeds GET /health.
const WINDOW_MS = 10 * 60 * 1000;

export function createSystemAlerts({ bus, store, now = () => Date.now() } = {}) {
  const last = new Map(); // `${tenantId}:${kind}` -> ts
  const lastByKind = new Map(); // kind -> ts (for /health, tenant-agnostic)

  return {
    fire(tenantId, kind, detail = null) {
      const ts = now();
      lastByKind.set(kind, ts);
      const key = `${tenantId || 'global'}:${kind}`;
      const prev = last.get(key);
      if (prev != null && ts - prev < WINDOW_MS) return false;
      last.set(key, ts);
      bus?.publish?.('system.alert', { tenantId: tenantId || null, kind, detail });
      try {
        store?.events
          ?.append?.(tenantId || 'system', {
            type: 'system.alert',
            actor: 'system',
            payload: { kind, detail },
          })
          ?.catch?.(() => {});
      } catch {
        /* best-effort audit */
      }
      return true;
    },
    /** True when `kind` fired within the window — health reporting. */
    recent(kind) {
      const ts = lastByKind.get(kind);
      return ts != null && now() - ts < WINDOW_MS;
    },
  };
}

export default createSystemAlerts;
