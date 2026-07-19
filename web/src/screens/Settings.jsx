// Settings (PRODUCT-SPEC §3.8): everything from the wizard, editable, plus the
// notification preferences UI and the account panel. Reuses the wizard form
// sections; each tab persists only its slice through PUT /api/tenant.
import React, { useState } from 'react';
import { useTenant } from '../context/TenantContext.jsx';
import { useI18n } from '../context/I18nContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useRoute, navigate } from '../router.js';
import {
  configToDraft, profilePatch, personaPatch, escalationPatch, notificationsPatch,
  ProfileForm, PersonaForm, EscalationForm, NotificationsForm,
} from '../components/forms.jsx';
import { KbManager } from '../components/KbManager.jsx';
import { Wand, Logout, Check } from '../components/icons.jsx';

const TABS = ['profile', 'persona', 'escalation', 'knowledge', 'notifications', 'account'];

export function Settings() {
  const { config, save } = useTenant();
  const { t, lang } = useI18n();
  const toast = useToast();
  const { user, logout } = useAuth();
  const route = useRoute();
  const initial = TABS.includes(route.segments[1]) ? route.segments[1] : 'profile';
  const [tab, setTab] = useState(initial);
  const [draft, setDraft] = useState(() => configToDraft(config));
  const [busy, setBusy] = useState(false);

  const saveSlice = async (build) => {
    setBusy(true);
    try {
      await save(build(draft));
      toast.ok(t('toast.saved'));
    } catch {
      toast.err(t('toast.error'));
    } finally {
      setBusy(false);
    }
  };

  const SaveBar = ({ onSave }) => (
    <div className="wizard-foot">
      <span className="spacer" />
      <button className="btn primary" onClick={onSave} disabled={busy}><Check />{busy ? t('common.saving') : t('common.save')}</button>
    </div>
  );

  const clinicName = draft.name || config.name || '';

  const body = () => {
    switch (tab) {
      case 'profile': return (<div className="card"><ProfileForm value={draft} onChange={setDraft} /><SaveBar onSave={() => saveSlice(profilePatch)} /></div>);
      case 'persona': return (<div className="card"><PersonaForm value={draft} onChange={setDraft} clinicName={clinicName} /><SaveBar onSave={() => saveSlice(personaPatch)} /></div>);
      case 'escalation': return (<div className="card"><EscalationForm value={draft} onChange={setDraft} /><SaveBar onSave={() => saveSlice(escalationPatch)} /></div>);
      case 'knowledge': return <KbManager specialties={draft.specialties} currency={draft.currency} />;
      case 'notifications': return (<div className="card"><NotificationsForm value={draft} onChange={setDraft} /><SaveBar onSave={() => saveSlice(notificationsPatch)} /></div>);
      case 'account': return (
        <div className="card stack">
          <div className="prow"><span className="k">{t('auth.ownerName')}</span><span className="v">{user?.name || '—'}</span></div>
          <div className="prow"><span className="k">{t('settings.email')}</span><span className="v" dir="ltr">{user?.email}</span></div>
          <div className="prow"><span className="k">{t('settings.role')}</span><span className="v cap">{user?.role}</span></div>
          <div className="prow"><span className="k">{t('settings.memberSince')}</span><span className="v">{user?.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString(lang === 'ar' ? 'ar-TN' : lang === 'en' ? 'en-GB' : 'fr-FR') : '—'}</span></div>
          <div className="card pad-sm" style={{ background: 'var(--bg-2)' }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--sp-3)' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t('settings.restartWizard')}</div>
                <div className="tiny muted">{t('settings.restartHint')}</div>
              </div>
              <button className="btn outline" onClick={() => navigate('/wizard')}><Wand />{t('nav.wizard')}</button>
            </div>
          </div>
          <div>
            <button className="btn danger" onClick={logout}><Logout />{t('settings.logout')}</button>
          </div>
        </div>
      );
      default: return null;
    }
  };

  const labels = {
    profile: t('settings.tabProfile'), persona: t('settings.tabPersona'), escalation: t('settings.tabEscalation'),
    knowledge: t('settings.tabKnowledge'), notifications: t('settings.tabNotifications'), account: t('settings.tabAccount'),
  };

  return (
    <div className="page">
      <div className="page-head"><div><h1>{t('settings.title')}</h1></div></div>
      <div className="tabs" role="tablist">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{labels[k]}</button>
        ))}
      </div>
      {body()}
    </div>
  );
}

export default Settings;
