// Ephemeral toast notifications. toast.ok / .err / .info from anywhere.
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { Check, Alert, Info } from '../components/icons.jsx';

const ToastContext = createContext(null);
let counter = 0;

const ICONS = { ok: Check, err: Alert, info: Info };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const remove = useCallback((id) => setToasts((list) => list.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message, kind = 'info', ttl = 3600) => {
      const id = ++counter;
      setToasts((list) => [...list, { id, message, kind }]);
      setTimeout(() => remove(id), ttl);
      return id;
    },
    [remove]
  );

  const toast = useMemo(
    () => ({
      ok: (m) => push(m, 'ok'),
      err: (m) => push(m, 'err'),
      info: (m) => push(m, 'info'),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((tst) => {
          const Ico = ICONS[tst.kind] || Info;
          return (
            <div key={tst.id} className={`toast ${tst.kind}`} onClick={() => remove(tst.id)}>
              <Ico />
              <span>{tst.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
