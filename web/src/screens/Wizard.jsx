// Onboarding wizard (PRODUCT-SPEC §2). One linear, resumable, mostly-skippable
// flow: profile → persona → knowledge → tourism → escalation → test drive → go
// live. Each config step persists its slice via PUT /api/tenant; knowledge
// persists through /api/kb; the test drive talks to the live engine.
import React, { useMemo, useState } from 'react';
import { useTenant } from '../context/TenantContext.jsx';
import { useI18n } from '../context/I18nContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { navigate } from '../router.js';
import {
  configToDraft, profilePatch, personaPatch, tourismPatch, escalationPatch,
  ProfileForm, PersonaForm, TourismForm, EscalationForm,
} from '../components/forms.jsx';
import { KbManager } from '../components/KbManager.jsx';
import { Sandbox } from '../components/Sandbox.jsx';
import { User, Bot, Book, Plane, Shield, Sparkle, Rocket, Check, ChevronLeft, ChevronRight, X } from '../components/icons.jsx';

const STEPS = [
  { key: 'profile', icon: User },
  { key: 'persona', icon: Bot },
  { key: 'knowledge', icon: Book },
  { key: 'tourism', icon: Plane },
  { key: 'escalation', icon: Shield },
  { key: 'testdrive', icon: Sparkle },
  { key: 'golive', icon: Rocket },
];

export function Wizard() {
  const { config, save } = useTenant();
  const { t } = useI18n();
  const toast = useToast();
  const { clearJustSetup } = useAuth();
  const [i, setI] = useState(0);
  const [draft, setDraft] = useState(() => configToDraft(config));
  const [busy, setBusy] = useState(false);

  const step = STEPS[i];
  const total = STEPS.length;
  const isLast = i === total - 1;
  const clinicName = draft.name || config.name || '';

  const patchFor = useMemo(
    () => ({
      profile: profilePatch, persona: personaPatch, tourism: tourismPatch, escalation: escalationPatch,
    }),
    []
  );

  const go = (n) => setI(Math.max(0, Math.min(total - 1, n)));

  const saveStep = async () => {
    const build = patchFor[step.key];
    if (!build) return true; // knowledge / testdrive / golive persist elsewhere
    setBusy(true);
    try {
      await save(build(draft));
      toast.ok(t('toast.saved'));
      return true;
    } catch {
      toast.err(t('toast.error'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onNext = async () => {
    if (await saveStep()) go(i + 1);
  };
  const onSkip = () => go(i + 1);
  const finish = () => {
    clearJustSetup();
    toast.ok(t('golive.launched'));
    navigate('/inbox');
  };
  const exit = () => {
    clearJustSetup();
    navigate('/inbox');
  };

  const Icon = step.icon;
  const nextLabel = ['knowledge', 'testdrive'].includes(step.key) ? t('common.next') : t('wizard.saveNext');

  const content = () => {
    switch (step.key) {
      case 'profile': return <ProfileForm value={draft} onChange={setDraft} />;
      case 'persona': return <PersonaForm value={draft} onChange={setDraft} clinicName={clinicName} />;
      case 'knowledge': return (
        <div className="stack">
          <p className="small dim">{t('knowledge.intro')}</p>
          <KbManager specialties={draft.specialties} currency={draft.currency} />
        </div>
      );
      case 'tourism': return <TourismForm value={draft} onChange={setDraft} />;
      case 'escalation': return <EscalationForm value={draft} onChange={setDraft} />;
      case 'testdrive': return <Sandbox botName={draft.persona.botName || clinicName} />;
      case 'golive': return (
        <div className="stack">
          <p className="dim">{t('golive.intro')}</p>
          <div className="card pad-sm">
            <div className="section-label" style={{ marginBottom: 'var(--sp-3)' }}>{t('golive.checklistTitle')}</div>
            <div className="stack-2">
              {['c1', 'c2', 'c3', 'c4', 'c5'].map((c) => (
                <div key={c} className="row" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
                  <span className="badge brass" aria-hidden="true"><Check /></span>
                  <span className="small">{t(`golive.${c}`)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="auth-note">{t('golive.runbookNote')}</div>
        </div>
      );
      default: return null;
    }
  };

  return (
    <div className="page">
      <div className="wizard">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--sp-4)' }}>
          <div>
            <h1>{t('wizard.title')}</h1>
            <p className="dim small">{t('wizard.subtitle')}</p>
          </div>
          <button className="btn ghost sm" onClick={exit}><X />{t('wizard.exit')}</button>
        </div>

        <div className="steps" role="progressbar" aria-valuenow={i + 1} aria-valuemin={1} aria-valuemax={total}>
          {STEPS.map((s, idx) => (
            <div key={s.key} className={`seg${idx < i ? ' done' : idx === i ? ' current' : ''}`}>
              <div className="fill" />
            </div>
          ))}
        </div>
        <div className="step-meta">
          <span>{t('wizard.stepOf', { n: i + 1, total })}</span>
          <span>{t(`wizard.steps.${step.key}.label`)}</span>
        </div>

        <div className="card fadein">
          <div className="row" style={{ gap: 'var(--sp-3)', marginBottom: 'var(--sp-5)' }}>
            <span className="step-icon"><Icon /></span>
            <div>
              <h2>{t(`wizard.steps.${step.key}.label`)}</h2>
              <p className="dim small">{t(`wizard.steps.${step.key}.desc`)}</p>
            </div>
          </div>

          {content()}

          <div className="wizard-foot">
            <button className="btn ghost" onClick={() => go(i - 1)} disabled={i === 0}><ChevronLeft />{t('common.back')}</button>
            <span className="spacer" />
            {!isLast ? <button className="btn outline" onClick={onSkip}>{t('wizard.skipStep')}</button> : null}
            {isLast ? (
              <button className="btn primary" onClick={finish}><Rocket />{t('golive.launch')}</button>
            ) : (
              <button className="btn primary" onClick={onNext} disabled={busy}>{nextLabel}<ChevronRight /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Wizard;
