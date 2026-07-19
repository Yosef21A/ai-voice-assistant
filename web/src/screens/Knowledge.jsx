// Knowledge base screen — the standalone manager (also embedded in the wizard
// and Settings). Prices + Q&A, both through /api/kb.
import React from 'react';
import { useI18n } from '../context/I18nContext.jsx';
import { useTenant } from '../context/TenantContext.jsx';
import { KbManager } from '../components/KbManager.jsx';

export function Knowledge() {
  const { t } = useI18n();
  const { config } = useTenant();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('nav.knowledge')}</h1>
          <p className="dim small">{t('knowledge.intro')}</p>
        </div>
      </div>
      <KbManager specialties={config.specialties || []} currency={config.currency || 'EUR'} />
    </div>
  );
}

export default Knowledge;
