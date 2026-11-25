// The breathing dot for one agent service: green and slowly pulsing when online, fast amber while checking,
// orange when the service named an auth/allow-list problem, and gray without motion when unreachable.
import { t } from '@src/ui/i18n';
import type { AgentHealth } from '@src/ui/agent-health';

const STYLES: Record<AgentHealth['status'], string> = {
  online: 'bg-emerald-500 animate-pulse',
  checking: 'bg-amber-400 animate-pulse [animation-duration:0.7s]',
  restricted: 'bg-orange-500',
  offline: 'bg-zinc-400 dark:bg-zinc-600',
};

function labelOf(health: AgentHealth): string {
  const parts =
    health.status === 'online'
      ? [t('agent.health.online', { version: health.version ?? '' })]
      : health.status === 'restricted'
        ? [t('agent.health.restricted', { detail: health.detail ?? '' })]
        : health.status === 'offline'
          ? [t('agent.health.offline', { detail: health.detail ?? '' })]
          : [t('agent.health.checking')];
  parts.push(new Date(health.checkedAt).toLocaleTimeString());
  return parts.filter(Boolean).join(' ').trim();
}

export function StatusDot({ health }: { health: AgentHealth | undefined }) {
  if (!health) return null;
  return (
    <span
      aria-label={labelOf(health)}
      role="img"
      title={labelOf(health)}
      className={`inline-block size-1.5 shrink-0 rounded-full ${STYLES[health.status]}`}
    />
  );
}
