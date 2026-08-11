// Unauthenticated entry: sign in, or bootstrap the first owner for a clinic that
// has no users yet (POST /api/auth/setup). AuthContext has already tried
// GET /api/auth/me; this renders only when status === 'anon'.
import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useI18n } from '../context/I18nContext.jsx';
import { Field } from '../components/ui.jsx';
import { glyph } from '../components/icons.jsx';

export function AuthScreen() {
  const { login, setup } = useAuth();
  const { t, lang, setLang, langs } = useI18n();
  const [mode, setMode] = useState('login'); // login | setup
  const [form, setForm] = useState({ clinicId: '', name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const mapError = (err) => {
    const s = err?.status;
    if (mode === 'login') return t('auth.errInvalid');
    if (s === 404) return t('auth.errUnknownTenant');
    if (s === 409) return t('auth.errAlreadyInit');
    if (s === 400) return form.password.length < 8 ? t('auth.errWeak') : t('auth.errGeneric');
    return t('auth.errGeneric');
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (mode === 'setup' && form.password.length < 8) {
      setError(t('auth.errWeak'));
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') await login({ email: form.email, password: form.password });
      else await setup({ tenantId: form.clinicId.trim(), email: form.email, password: form.password, name: form.name });
    } catch (err) {
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card card fadein">
        <div className="auth-top">
          <span className="brand">
            <span className="glyph">{glyph}</span>
            <span className="brand-name">Omen <b>Concierge</b></span>
          </span>
          <span className="langpick">
            {langs.map((l) => (
              <button key={l} type="button" className={lang === l ? 'active' : ''} onClick={() => setLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </span>
        </div>

        <h1 style={{ marginBottom: 4 }}>{t('auth.welcome')}</h1>
        <p className="dim small" style={{ marginBottom: 'var(--sp-5)' }}>{t('auth.subtitle')}</p>

        <div className="auth-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(null); }}>{t('auth.tabLogin')}</button>
          <button role="tab" aria-selected={mode === 'setup'} className={mode === 'setup' ? 'active' : ''} onClick={() => { setMode('setup'); setError(null); }}>{t('auth.tabSetup')}</button>
        </div>

        <form className="stack" onSubmit={submit}>
          {mode === 'setup' ? (
            <>
              <Field label={t('auth.clinicId')} hint={t('auth.clinicIdHint')} htmlFor="a-clinic">
                <input id="a-clinic" className="control" autoComplete="off" value={form.clinicId} onChange={set('clinicId')} required placeholder="el-amen-sousse" />
              </Field>
              <Field label={t('auth.ownerName')} htmlFor="a-name">
                <input id="a-name" className="control" autoComplete="name" value={form.name} onChange={set('name')} />
              </Field>
            </>
          ) : null}
          <Field label={t('auth.email')} htmlFor="a-email">
            <input id="a-email" className="control" type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
          </Field>
          <Field label={t('auth.password')} hint={mode === 'setup' ? t('auth.passwordHint') : undefined} htmlFor="a-pass">
            <input id="a-pass" className="control" type="password" autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} value={form.password} onChange={set('password')} required minLength={mode === 'setup' ? 8 : undefined} />
          </Field>
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? (mode === 'login' ? t('auth.signingIn') : t('auth.creating')) : (mode === 'login' ? t('auth.signIn') : t('auth.createAccount'))}
          </button>
        </form>

        <div className="center small" style={{ marginTop: 'var(--sp-4)' }}>
          <button className="btn ghost sm" onClick={() => { setMode(mode === 'login' ? 'setup' : 'login'); setError(null); }}>
            {mode === 'login' ? t('auth.firstTime') : t('auth.alreadyHave')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AuthScreen;
