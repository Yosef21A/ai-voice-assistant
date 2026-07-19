// i18n registry + a tiny dotted-path lookup with {var} interpolation.
// FR is the default and fallback so a missing AR/EN key never shows a raw id.
import fr from './fr.js';
import ar from './ar.js';
import en from './en.js';

export const DICTS = { fr, ar, en };
export const LANGS = ['fr', 'ar', 'en'];
export const RTL_LANGS = new Set(['ar']);
export const DEFAULT_LANG = 'fr';

function walk(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function translate(lang, key, vars) {
  let val = walk(DICTS[lang], key);
  if (val == null) val = walk(DICTS[DEFAULT_LANG], key);
  if (val == null) return key;
  if (typeof val !== 'string') return val;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return val;
}

export const isRtl = (lang) => RTL_LANGS.has(lang);
