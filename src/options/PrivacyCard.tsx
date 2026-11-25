// Settings → Data → Privacy: a statement of what this build does with data. Telemetry is disabled in the
// build itself (see src/extension/analytics.ts), so there are no switches to offer.
import { t } from '@src/ui/i18n';
import { SettingsCard } from './SettingsCard';

export function PrivacyCard() {
  return (
    <SettingsCard title={t('privacy.title')} className="flex flex-col gap-2">
      <p className="text-sm">{t('privacy.body')}</p>
      <p className="text-sm text-nb-muted">{t('privacy.bodyHint')}</p>
    </SettingsCard>
  );
}
