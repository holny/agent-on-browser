// Settings → About: the version and the project's licence. The engine this build is powered by is
// Nanobrowser (upstream); the product itself is AgentOnBrowser.
import { SettingsCard } from './SettingsCard';
import { t } from '@src/ui/i18n';

export function AboutSection() {
  const manifest = chrome.runtime.getManifest();
  return (
    <div className="flex flex-col gap-6">
      <h2 className="sr-only">{t('settings.nav.about')}</h2>
      <SettingsCard title="AgentOnBrowser" className="flex flex-col gap-1">
        <p className="text-sm">{t('about.version', { version: manifest.version })}</p>
        <p className="text-sm text-nb-muted">{t('about.license', { license: 'Apache-2.0' })}</p>
        <p className="text-sm text-nb-muted">{t('about.poweredBy')}</p>
      </SettingsCard>
    </div>
  );
}
