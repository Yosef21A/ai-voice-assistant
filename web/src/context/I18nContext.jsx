// Language state + document direction flip. Persisted in localStorage; selecting
// Arabic sets <html dir="rtl"> so the entire app mirrors, site-wide.
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { translate, isRtl, LANGS, DEFAULT_LANG } from '../i18n/index.js';

const LS_KEY = 'omen:lang';
const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    const saved = localStorage.getItem(LS_KEY);
    return LANGS.includes(saved) ? saved : DEFAULT_LANG;
  });
  const dir = isRtl(lang) ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((l) => {
    if (!LANGS.includes(l)) return;
    localStorage.setItem(LS_KEY, l);
    setLangState(l);
  }, []);

  const t = useCallback((key, vars) => translate(lang, key, vars), [lang]);

  const value = useMemo(() => ({ lang, dir, setLang, t, langs: LANGS }), [lang, dir, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
