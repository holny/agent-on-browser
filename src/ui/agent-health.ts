// The agent service breathing light: a small poller that asks each configured V2 service for its /api/info every
// 30 seconds (and on demand, e.g. when the picker opens) and classifies the answer into a status a dot can show.
// Lives here so the side panel and the settings page share one implementation.
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectService, TransportError, type ServerInfo } from '@src/opencode-v2/http';
import { agentKeyOf, agentKeysStorage } from '@src/store/settings';

export type AgentHealthStatus = 'checking' | 'online' | 'restricted' | 'offline';

export interface AgentHealth {
  status: AgentHealthStatus;
  /** The service's version string when it answered /api/info. */
  version?: string;
  /** The failure detail for restricted/offline, e.g. "HTTP 403". */
  detail?: string;
  checkedAt: number;
}

export interface AgentHealthTarget {
  id: string;
  url?: string;
}

/** Online when the service answered; orange when it named an auth/allow-list problem; otherwise offline. */
export function classifyHealth(error: unknown, info?: ServerInfo): AgentHealth {
  const checkedAt = Date.now();
  if (!error) return { status: 'online', version: info?.version, checkedAt };
  if (error instanceof TransportError && (error.status === 401 || error.status === 403))
    return { status: 'restricted', detail: `HTTP ${error.status}`, checkedAt };
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'offline', detail: message.slice(0, 120), checkedAt };
}

const POLL_INTERVAL_MS = 30_000;
const CHECK_TIMEOUT_MS = 3_000;

/** Polls every listed V2 agent's service; agents without a URL (the built-in one) get no entry. */
export function useAgentHealth(agents: AgentHealthTarget[]): {
  health: Record<string, AgentHealth>;
  refresh: () => void;
} {
  const [health, setHealth] = useState<Record<string, AgentHealth>>({});
  const busy = useRef(false);
  const key = agents.map(a => `${a.id}@${a.url ?? ''}`).join('|');
  const targetsRef = useRef(agents);
  targetsRef.current = agents;

  const refresh = useCallback(() => {
    const targets = targetsRef.current.filter(a => a.url);
    if (targets.length === 0 || busy.current) return;
    busy.current = true;
    setHealth(previous => {
      const next = { ...previous };
      for (const a of targets)
        next[a.id] = { ...(next[a.id] ?? {}), status: 'checking', checkedAt: Date.now() } as AgentHealth;
      return next;
    });
    void (async () => {
      const keys = await agentKeysStorage.get();
      await Promise.all(
        targets.map(async a => {
          let result: AgentHealth;
          try {
            const info = await connectService({
              baseUrl: a.url!,
              password: keys[agentKeyOf(a.id)] ?? '',
              timeoutMs: CHECK_TIMEOUT_MS,
            });
            result = classifyHealth(undefined, info);
          } catch (error) {
            result = classifyHealth(error);
          }
          setHealth(previous => ({ ...previous, [a.id]: result }));
        }),
      );
      busy.current = false;
    })();
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [key, refresh]);

  return { health, refresh };
}
