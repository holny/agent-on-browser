// Settings → Agent: 智能体接入管理，结构与提供商设置一致（默认选择卡 + 卡片列表 + 添加行）。
// 内置智能体不在此列：它不需要配置；这里管理的是外部智能体服务（OpenCode V2，后续还有其他协议）。
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  addAgent,
  agentKeyOf,
  agentKeysStorage,
  agentsStorage,
  BUILTIN_AGENT_ID,
  DEFAULT_SETTINGS,
  settingsStorage,
  type AgentConfig,
} from '@src/store/settings';
import { connectService, TransportError } from '@src/opencode-v2';
import { useStorage } from '@src/ui/hooks';
import { t, type MessageKey } from '@src/ui/i18n';
import { useAgentHealth, type AgentHealth } from '@src/ui/agent-health';
import { StatusDot } from '@src/ui/status-dot';
import { Button, Input, Select } from '@src/ui/components';
import { TrashIcon, RestartIcon } from '@src/ui/icons';
import { KeyInput } from './ProvidersSection';
import { SettingsCard } from './SettingsCard';

type AgentKind = AgentConfig['kind'];

const KIND_LABELS: Record<AgentKind, MessageKey> = { 'opencode-v2': 'agent.kindV2' };
const ICON_BUTTON =
  'rounded-md p-1.5 text-nb-muted hover:bg-nb-surface hover:text-nb-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent';

/** 与提供商卡片相同的两列行：左侧 9rem 标签，右侧控件。 */
function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <span className="text-nb-muted sm:pt-1.5">{label}</span>
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </>
  );
}

function ConnectionTest({ url, password }: { url: string; password: string }) {
  const [state, setState] = useState<'idle' | 'testing' | { ok: string } | { error: string }>('idle');
  const test = async () => {
    setState('testing');
    try {
      const info = await connectService({ baseUrl: url, ...(password ? { password } : {}), timeoutMs: 8000 });
      setState({ ok: t('agent.v2Ok', { version: info.version }) });
    } catch (error) {
      const message = error instanceof TransportError || error instanceof Error ? error.message : t('agent.v2Fail');
      setState({ error: message });
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button onClick={() => void test()} disabled={!url.trim() || state === 'testing'}>
          {state === 'testing' ? t('agent.v2Testing') : t('agent.v2Test')}
        </Button>
      </div>
      {typeof state === 'object' && 'ok' in state ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">{state.ok}</p>
      ) : null}
      {typeof state === 'object' && 'error' in state ? <p className="text-sm text-red-600">{state.error}</p> : null}
    </div>
  );
}

function AgentCard({
  agent,
  health,
  refreshHealth,
  onRemove,
}: {
  agent: AgentConfig;
  health?: AgentHealth;
  refreshHealth: () => void;
  onRemove: () => void;
}) {
  const keys = useStorage(agentKeysStorage, {});
  const password = keys[agentKeyOf(agent.id)] ?? '';
  const v2 = agent.kind === 'opencode-v2';
  return (
    <li className="flex flex-col gap-3 py-6">
      {/* 头部行：名称 + 测试连接 + 移除，与提供商卡片一致 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          {v2 ? <StatusDot health={health} /> : null}
          {agent.name || t(KIND_LABELS[agent.kind])}
        </span>
        <span className="flex-1" />
        {v2 ? (
          <button
            type="button"
            aria-label={t('agent.v2Test')}
            title={t('agent.v2Test')}
            className={ICON_BUTTON}
            onClick={() => refreshHealth()}>
            <RestartIcon size={16} />
          </button>
        ) : null}
        <ConnectionTest url={agent.url} password={password} />
        <button
          type="button"
          aria-label={t('agent.remove')}
          title={t('agent.remove')}
          className={ICON_BUTTON}
          onClick={onRemove}>
          <TrashIcon size={16} />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-y-2">
        <Line label={t('agent.name')}>
          <Input
            aria-label={t('agent.name')}
            className="w-72 max-w-full"
            value={agent.name}
            onChange={e =>
              void agentsStorage.set(list => list.map(a => (a.id === agent.id ? { ...a, name: e.target.value } : a)))
            }
          />
        </Line>
        {v2 ? (
          <>
            <Line label={t('agent.v2Url')}>
              <Input
                aria-label={t('agent.v2Url')}
                className="w-72 max-w-full"
                value={agent.url}
                onChange={e =>
                  void agentsStorage.set(list => list.map(a => (a.id === agent.id ? { ...a, url: e.target.value } : a)))
                }
              />
            </Line>
            <Line label={t('agent.v2Password')}>
              <KeyInput
                label={t('agent.v2Password')}
                className="w-72 max-w-full"
                value={password}
                onChange={value =>
                  void agentKeysStorage.set(keys => ({ ...keys, [agentKeyOf(agent.id)]: value.trim() }))
                }
              />
            </Line>
            <Line label={t('agent.v2Directory')}>
              <Input
                aria-label={t('agent.v2Directory')}
                className="w-72 max-w-full"
                value={agent.directory ?? ''}
                onChange={e =>
                  void agentsStorage.set(list =>
                    list.map(a => (a.id === agent.id ? { ...a, directory: e.target.value } : a)),
                  )
                }
              />
            </Line>
          </>
        ) : null}
      </div>
    </li>
  );
}

/** 添加智能体：选类型，保存后卡片出现在下方。 */
function AddAgent({ onAdd }: { onAdd: (kind: AgentKind) => void }) {
  const [kind, setKind] = useState<AgentKind>('opencode-v2');
  return (
    <div className="mt-4 flex items-center gap-8">
      <label className="flex items-center gap-2">
        <span className="text-nb-muted">{t('agent.addKind')}</span>
        <Select aria-label={t('agent.addKind')} value={kind} onChange={e => setKind(e.target.value as AgentKind)}>
          <option value="opencode-v2">{t('agent.kindV2')}</option>
        </Select>
      </label>
      <Button variant="primary" onClick={() => onAdd(kind)}>
        {t('agent.add')}
      </Button>
    </div>
  );
}

export function AgentSection() {
  const agents = useStorage(agentsStorage, []);
  const settings = useStorage(settingsStorage, DEFAULT_SETTINGS);
  const v2Agents = agents.filter(a => a.kind === 'opencode-v2');
  const { health: agentHealth, refresh: refreshAgentHealth } = useAgentHealth(
    v2Agents.map(a => ({ id: a.id, url: a.url })),
  );
  return (
    <section className="flex flex-col gap-6">
      <h2 className="sr-only">{t('settings.nav.agent')}</h2>
      <SettingsCard
        title={t('agent.defaultTitle')}
        description={t('agent.defaultHint')}
        className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <label className="flex min-w-0 max-w-full items-center gap-3">
          <span className="text-nb-muted">{t('agent.default')}</span>
          <Select
            aria-label={t('agent.default')}
            className="min-w-0 sm:max-w-xs"
            value={settings.defaultAgentId ?? BUILTIN_AGENT_ID}
            onChange={e => void settingsStorage.set(s => ({ ...s, defaultAgentId: e.target.value }))}>
            <option value="builtin">{t('agent.engineBuiltin')}</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
      </SettingsCard>
      <ul className="flex flex-col">
        {agents.map(agent => (
          <AgentCard
            key={agent.id}
            agent={agent}
            health={agentHealth[agent.id]}
            refreshHealth={refreshAgentHealth}
            onRemove={() => {
              void agentsStorage.set(list => list.filter(a => a.id !== agent.id));
              void agentKeysStorage.set(keys => {
                const next = { ...keys };
                delete next[agentKeyOf(agent.id)];
                return next;
              });
              if (settings.defaultAgentId === agent.id)
                void settingsStorage.set(s => ({ ...s, defaultAgentId: BUILTIN_AGENT_ID }));
            }}
          />
        ))}
      </ul>
      <AddAgent
        onAdd={kind => void agentsStorage.set(list => addAgent(list, { kind, name: t(KIND_LABELS[kind]), url: '' }))}
      />
    </section>
  );
}
