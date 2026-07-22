// Knowledge base screen — Q&A/prices manager plus the "À entraîner" training
// queue (P2-B). The tab badge and the queue stay live via kb.unanswered SSE.
// KbManager stays tab-free because it is also embedded in the wizard/Settings.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useI18n } from '../context/I18nContext.jsx';
import { useTenant } from '../context/TenantContext.jsx';
import { useStreamEvent } from '../context/EventStreamContext.jsx';
import { KbManager } from '../components/KbManager.jsx';
import { TrainingQueue } from '../components/TrainingQueue.jsx';

export function Knowledge() {
  const { t } = useI18n();
  const { config } = useTenant();
  const [tab, setTab] = useState('qa');
  const [pending, setPending] = useState(0);
  const timerRef = useRef(null);

  const refresh = useCallback(() => {
    api.listUnanswered().then(({ unanswered }) => setPending(unanswered.length)).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const schedule = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(refresh, 400);
  }, [refresh]);
  useStreamEvent('kb.unanswered', schedule);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('nav.knowledge')}</h1>
          <p className="dim small">{t('knowledge.intro')}</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'qa'} className={tab === 'qa' ? 'active' : ''} onClick={() => setTab('qa')}>
          {t('knowledge.qaTab')}
        </button>
        <button role="tab" aria-selected={tab === 'training'} className={tab === 'training' ? 'active' : ''} onClick={() => setTab('training')}>
          {t('knowledge.trainTab')}{pending > 0 ? ` (${pending})` : ''}
        </button>
      </div>
      {tab === 'qa' ? (
        <KbManager specialties={config.specialties || []} currency={config.currency || 'EUR'} />
      ) : (
        <TrainingQueue onTrained={refresh} />
      )}
    </div>
  );
}

export default Knowledge;
