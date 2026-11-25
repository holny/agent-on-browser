// The composer's agent picker: a menu built like the model menu, listing the built-in agent and the agents the user
// added. Which agent answers a run; the model menu's choices follow it. Each agent item carries a breathing dot
// with the service's live status, refreshed whenever the menu opens.
import { useEffect, useRef, useState } from 'react';
import { t } from '@src/ui/i18n';
import { StatusDot } from '@src/ui/status-dot';
import type { AgentHealth } from '@src/ui/agent-health';
import { CheckIcon, ChevronIcon } from '@src/ui/icons';

export interface AgentChoice {
  id: string;
  name: string;
}

export function AgentMenu({
  agents,
  agentId,
  running,
  health,
  onOpenRefresh,
  onAgent,
}: {
  agents: AgentChoice[];
  agentId: string;
  running: boolean;
  health?: Record<string, AgentHealth>;
  /** Called when the menu opens, so the dots show a fresh check rather than one up to 30 seconds old. */
  onOpenRefresh?: () => void;
  onAgent: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const current = agents.find(a => a.id === agentId);
  const label = current ? current.name : t('composer.agentBuiltin');

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div
      ref={root}
      className="flex min-w-0 shrink-0"
      onBlur={e => {
        if (open && !root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}>
      <button
        ref={button}
        type="button"
        disabled={running}
        aria-label={`${t('composer.agent')}: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-label={t('composer.agent')}
        data-value={agentId}
        className="flex min-w-0 items-center gap-1 rounded-full border border-transparent px-2 py-1 text-xs text-nb-muted hover:border-nb-border hover:text-nb-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-nb-accent/40 disabled:hover:border-transparent disabled:hover:text-nb-muted"
        onClick={() => {
          setOpen(o => {
            if (!o) onOpenRefresh?.();
            return !o;
          });
        }}>
        {current ? <StatusDot health={health?.[agentId]} /> : null}
        <span className="truncate">{label}</span>
        <ChevronIcon size={12} className={`shrink-0 transition-transform ${open ? '-rotate-90' : 'rotate-90'}`} />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t('composer.agent')}
          tabIndex={-1}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
              const at = items.indexOf(document.activeElement as HTMLElement);
              items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
            }
          }}
          className="absolute bottom-11 left-2 z-10 flex w-64 max-w-[calc(100%-1rem)] flex-col rounded-xl border border-nb-border bg-nb-bg p-1 text-xs shadow-pop">
          <div className="flex max-h-60 flex-col overflow-y-auto">
            {agents.map(a => (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={a.id === agentId}
                tabIndex={a.id === agentId || (!current && a === agents[0]) ? 0 : -1}
                data-value={a.id}
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-nb-surface focus-visible:bg-nb-surface focus-visible:outline-none"
                onClick={() => {
                  close();
                  if (a.id !== agentId) onAgent(a.id);
                }}>
                <StatusDot health={health?.[a.id]} />
                <span className="min-w-0 flex-1 truncate text-nb-fg">{a.name}</span>
                <CheckIcon size={14} className={a.id === agentId ? 'text-nb-accent' : 'invisible'} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
