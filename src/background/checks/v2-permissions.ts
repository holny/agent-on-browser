import { defineCheck } from './registry';
import { openPanelTab, panel, waitForText } from './panel-chat';
import { assert, sleep } from './helpers';

const FIXTURES = (import.meta.env.WXT_AUTORUN_URL as string | undefined) ?? 'http://localhost:8787';
const AGENT_ID = 'nb-agent-v2-permissions';
const DIRECTORY = '/tmp/nanobrowser-v2-mock';
const CARD_TITLE = 'Allow the agent service to do this?';
const ASKS = [
  { action: 'browser.tabs.open', resources: [`${FIXTURES}/v2-perm-once`], token: 'MOCK-V2-ONCE-DONE' },
  { action: 'browser.page.read', resources: [`${FIXTURES}/v2-perm-deny`], token: 'MOCK-V2-DENY-DONE' },
];
const FIXTURE_PROVIDER = {
  id: 'fixture',
  kind: 'openai-compatible' as const,
  name: 'Fixture model',
  baseUrl: `${FIXTURES}/__llm/v1`,
  models: [{ name: 'fixture-model', overrides: { contextWindow: 32768 } }],
};

interface MockState {
  url: string;
  sessions: Array<{ id: string }>;
  prompts: Array<{ sessionId: string; text: string }>;
  asked: Array<{ id: string; action: string; resources: string[]; token: string }>;
  replies: Array<{ requestId: string; decision: string }>;
  toolLists: Array<{ tools: string[] }>;
  mcpConnections: Array<{ name: string }>;
}

async function mockState(): Promise<MockState> {
  return (await (await fetch(`${FIXTURES}/__v2mock/state`)).json()) as MockState;
}

async function waitForCard(tabId: number, needle: string, what: string): Promise<string> {
  const end = Date.now() + 20_000;
  let body = '';
  while (Date.now() < end) {
    body = (await panel(tabId, 'read')).body;
    if (body.includes(CARD_TITLE) && body.includes(needle)) return body;
    await sleep(200);
  }
  throw new Error(`the permission card for ${what} never opened. Panel body:\n${body}`);
}

export const v2Permissions = defineCheck({
  name: 'v2-permissions',
  title: 'OpenCode V2 permission answers',
  description:
    'The mock local V2 service in the fixture server (in-memory, its own ephemeral port) asks a permission on each of two scripted runs; the panel card is answered Allow once and Deny once, and the service must have received exactly one reply each: once, then reject.',
  run: async () => {
    const info = (await (await fetch(`${FIXTURES}/__v2mock/info`)).json()) as { url?: string };
    assert(
      !!info.url && /^http:\/\/127\.0\.0\.1:\d+$/.test(info.url),
      `the mock V2 service is not reachable: ${JSON.stringify(info)}`,
    );
    const serviceUrl = info.url!;
    await fetch(`${FIXTURES}/__v2mock/reset`, { method: 'POST' });
    await fetch(`${FIXTURES}/__v2mock/script`, {
      method: 'POST',
      body: JSON.stringify({ asks: ASKS }),
    });

    const savedAgents = (await chrome.storage.local.get('nb.agents'))['nb.agents'] ?? [];
    const savedKeys = (await chrome.storage.local.get('nb.agent-keys'))['nb.agent-keys'] ?? {};
    const savedSettings = (await chrome.storage.local.get('nb.settings'))['nb.settings'] ?? {};
    const savedProviders = (await chrome.storage.local.get('nb.providers'))['nb.providers'] ?? [];
    await chrome.storage.local.set({
      'nb.providers': [FIXTURE_PROVIDER],
      'nb.agents': [
        ...(savedAgents as Array<{ id: string }>).filter(a => a.id !== AGENT_ID),
        { id: AGENT_ID, kind: 'opencode-v2', name: 'OpenCode V2 permissions', url: serviceUrl, directory: DIRECTORY },
      ],
      'nb.agent-keys': { ...(savedKeys as Record<string, string>), [`agent:${AGENT_ID}`]: '' },
      'nb.settings': {
        ...(savedSettings as Record<string, unknown>),
        defaultMode: 'ask',
        defaultModel: { providerId: 'fixture', model: 'fixture-model' },
        defaultAgentId: AGENT_ID,
      },
    });

    const tab = await openPanelTab();
    try {
      await panel(tab.id!, 'type-send', { text: 'Run the first scripted step.' });
      await waitForCard(tab.id!, ASKS[0].resources[0], 'approve');
      const allow = await panel(tab.id!, 'click', { label: 'Allow' });
      assert(allow.ok, 'the Allow button was not found on the first permission card');
      const first = await waitForText(tab.id!, ASKS[0].token, 30_000);
      assert(/done|ready/i.test(first.status), `the first run did not end cleanly: ${first.status}`);
      await sleep(1_000);

      let state = await mockState();
      assert(state.asked.length === 1, `expected one permission ask, the mock recorded ${state.asked.length}`);
      assert(
        state.asked[0].action === ASKS[0].action,
        `the first ask was ${state.asked[0].action}, expected ${ASKS[0].action}`,
      );
      assert(
        JSON.stringify(state.asked[0].resources) === JSON.stringify(ASKS[0].resources),
        `the first ask named ${JSON.stringify(state.asked[0].resources)}, expected ${JSON.stringify(ASKS[0].resources)}`,
      );
      assert(
        state.replies.length === 1,
        `an approved permission must be answered exactly once, the mock recorded ${JSON.stringify(state.replies)}`,
      );
      assert(
        state.replies[0].requestId === state.asked[0].id && state.replies[0].decision === 'once',
        `approving must answer the reply once, the mock recorded ${JSON.stringify(state.replies)}`,
      );
      assert(
        state.prompts.length === 1 && state.prompts[0].text.includes('first scripted step'),
        `the prompt did not reach the mock service: ${JSON.stringify(state.prompts)}`,
      );
      assert(
        state.toolLists.some(l => l.tools.includes('tabs') && l.tools.includes('snapshot')),
        `the browser tools never attached over client MCP: ${JSON.stringify(state.toolLists)}`,
      );

      await panel(tab.id!, 'type-send', { text: 'Run the second scripted step.' });
      await waitForCard(tab.id!, ASKS[1].resources[0], 'deny');
      const deny = await panel(tab.id!, 'click', { label: 'Deny' });
      assert(deny.ok, 'the Deny button was not found on the second permission card');
      const second = await waitForText(tab.id!, ASKS[1].token, 30_000);
      assert(/done|ready/i.test(second.status), `the second run did not end cleanly: ${second.status}`);
      await sleep(1_000);

      state = await mockState();
      assert(state.asked.length === 2, `expected two permission asks, the mock recorded ${state.asked.length}`);
      assert(
        state.asked[1].action === ASKS[1].action,
        `the second ask was ${state.asked[1].action}, expected ${ASKS[1].action}`,
      );
      assert(
        state.replies.length === 2,
        `each ask is answered exactly once, the mock recorded ${JSON.stringify(state.replies)}`,
      );
      const decisions = state.replies.map(r => r.decision);
      assert(
        decisions[0] === 'once' && decisions[1] === 'reject',
        `approve must answer once and deny must answer reject, the mock recorded ${JSON.stringify(decisions)}`,
      );
      assert(
        state.replies[1].requestId === state.asked[1].id,
        `the deny reply went to the wrong ask: ${JSON.stringify(state.replies)}`,
      );
      assert(state.sessions.length === 2, `each run opens its own session, the mock recorded ${state.sessions.length}`);

      return {
        serviceUrl,
        sessions: state.sessions.length,
        prompts: state.prompts.map(p => p.text),
        asked: state.asked.map(a => ({ action: a.action, resources: a.resources })),
        replies: decisions,
        tools: state.toolLists.at(-1)?.tools.slice(0, 12),
        transcript: second.transcript.slice(-400),
      };
    } finally {
      await chrome.tabs.remove(tab.id!).catch(() => undefined);
      await chrome.storage.local.set({
        'nb.agents': savedAgents,
        'nb.agent-keys': savedKeys,
        'nb.settings': savedSettings,
        'nb.providers': savedProviders,
      });
      await import('@src/store/settings').then(m => void m.settingsStorage.get());
      await fetch(`${FIXTURES}/__v2mock/reset`, { method: 'POST' }).catch(() => undefined);
    }
  },
});
