// Auth state. Bootstraps from GET /api/auth/me; a 401 anywhere drops back to the
// login screen. `justSetup` is true immediately after first-owner setup so the
// shell opens the onboarding wizard.
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { api, setUnauthorizedHandler } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading'); // loading | authed | anon
  const [user, setUser] = useState(null);
  const [justSetup, setJustSetup] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .me()
      .then(({ user: u }) => alive && (setUser(u), setStatus('authed')))
      .catch(() => alive && (setUser(null), setStatus('anon')));
    return () => {
      alive = false;
    };
  }, []);

  // Background 401s (e.g. a slid-out session) reset to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setStatus((s) => (s === 'authed' ? 'anon' : s));
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (creds) => {
    const { user: u } = await api.login(creds);
    setJustSetup(false);
    setUser(u);
    setStatus('authed');
    return u;
  }, []);

  const setup = useCallback(async (body) => {
    const { user: u } = await api.setup(body);
    setJustSetup(true);
    setUser(u);
    setStatus('authed');
    return u;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* ignore — clear locally regardless */
    }
    setUser(null);
    setStatus('anon');
  }, []);

  const value = useMemo(
    () => ({ status, user, justSetup, clearJustSetup: () => setJustSetup(false), login, setup, logout }),
    [status, user, justSetup, login, setup, logout]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
