// Tenant profile/config, shared by the wizard and settings. `save(patch)` PUTs to
// /api/tenant and stores the returned canonical tenant so every screen stays in
// sync. `config` is the clinic-shaped object the API persists and the engine reads.
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../api/client.js';

const TenantContext = createContext(null);

export function TenantProvider({ children }) {
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { tenant: t } = await api.getTenant();
      setTenant(t);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = useCallback(async (patch) => {
    const { tenant: t } = await api.putTenant(patch);
    setTenant(t);
    return t;
  }, []);

  const value = useMemo(
    () => ({ tenant, config: tenant?.config || {}, loading, error, reload, save }),
    [tenant, loading, error, reload, save]
  );
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export const useTenant = () => useContext(TenantContext);
