// Tiny dependency-free hash router. Hash routing keeps the SPA self-contained
// (works from any base path, survives refresh without server round-trips) while
// server.js still serves index.html as an SPA fallback for the initial load.
// Routes used by the shell: #/inbox, #/inbox/<id>, #/appointments,
// #/knowledge, #/settings[/tab], #/wizard.
import { useEffect, useState, useCallback } from 'react';

function currentPath() {
  const h = window.location.hash || '';
  const raw = h.startsWith('#') ? h.slice(1) : h;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/** Parse "/inbox/el-amen%3A218" -> { segments:['inbox','el-amen:218'], path }. */
export function parseRoute(path) {
  const clean = path.split('?')[0];
  const segments = clean.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { path: clean, segments, top: segments[0] || '' };
}

export function navigate(to) {
  const target = to.startsWith('/') ? to : `/${to}`;
  if (currentPath() === target) return;
  window.location.hash = `#${target}`;
}

/** Build a route string, encoding each dynamic segment safely. */
export function routeTo(...parts) {
  return `/${parts.filter((p) => p != null && p !== '').map((p) => encodeURIComponent(String(p))).join('/')}`;
}

/** Subscribe to the current hash route. Returns { path, segments, top, navigate }. */
export function useRoute() {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener('hashchange', onChange);
    // Normalize an empty hash to the default route once on mount.
    if (!window.location.hash) window.location.replace('#/inbox');
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback((to) => navigate(to), []);
  return { ...parseRoute(path), navigate: go };
}
