// Switching agents in the composer of an EXISTING conversation: the worker must answer set-agent by broadcasting
// the new live pair, so the picker's checked agent follows (a swallowed broadcast left the old agent checked while
// runs already used the new one). Uses the fixture mock service once to get a real conversation with a live pair.
import { defineCheck } from './registry';
import { openPanelTab, panel } from './panel-chat';
import { assert, sleep } from './helpers';

const FIXTURES = (import.meta.env.WXT_AUTORUN_URL as string | undefined) ?? 'http://localhost:8787';
const CODE_ID = 'nb-agent-switch-code';
const WORK_ID = 'nb-agent-switch-work';
const CODE_NAME = 'OpenCode V2 code';
const WORK_NAME = 'OpenCode V2 work';
const DONE_TOKEN = 'MOCK-V2-NO-ASK-SCRIPTED';
const FIXTURE_PROVIDER = {
  id: 'fixture',
  kind: 'openai-compatible' as const,
  name: 'Fixture model',
  baseUrl: `${FIXTURES}/__llm/v1`,
  models: [{ name: 'fixture-model', overrides: { contextWindow: 32768 } }],
};

function agentLabel(read: { buttons?: string[] }): string | undefined {
  return read.buttons?.find(l => l.startsWith('Agent:'));
}

export const v2AgentSwitch = defineCheck({
  name: 'v2-agent-switch',
  title: 'Agent switch in a conversation',
  description:
    'A conversation runs once on the first of two agents from the fixture mock service; picking the second agent in the composer menu must check it in the picker and the next message must still run.',
  run: async () => {
    const info = (await (await fetch(`${FIXTURES}/__v2mock/info`)).json()) as { url?: string };
    assert(!!info.url, `the mock V2 service is not reachable: ${JSON.stringify(info)}`);
    const serviceUrl = info.url!;
    await fetch(`${FIXTURES}/__v2mock/reset`, { method: 'POST' });

    const savedAgents = (await chrome.storage.local.get('nb.agents'))['nb.agents'] ?? [];
    const savedKeys = (await chrome.storage.local.get('nb.agent-keys'))['nb.agent-keys'] ?? {};
    const savedSettings = (await chrome.storage.local.get('nb.settings'))['nb.settings'] ?? {};
    const savedProviders = (await chrome.storage.local.get('nb.providers'))['nb.providers'] ?? [];
    await chrome.storage.local.set({
      'nb.providers': [FIXTURE_PROVIDER],
      'nb.agents': [
        ...(savedAgents as Array<{ id: string }>).filter(a => a.id !== CODE_ID && a.id !== WORK_ID),
        { id: CODE_ID, kind: 'opencode-v2', name: CODE_NAME, url: serviceUrl, directory: '/tmp/nb-switch-code' },
        { id: WORK_ID, kind: 'opencode-v2', name: WORK_NAME, url: serviceUrl, directory: '/tmp/nb-switch-work' },
      ],
      'nb.agent-keys': { ...(savedKeys as Record<string, string>), [CODE_ID]: '', [WORK_ID]: '' },
      'nb.settings': {
        ...(savedSettings as Record<string, unknown>),
        defaultMode: 'ask',
        defaultModel: { providerId: 'fixture', model: 'fixture-model' },
        defaultAgentId: CODE_ID,
      },
    });

    const tab = await openPanelTab();
    try {
      // A first run gives the conversation its live pair; the mock finishes an unscripted prompt on its own.
      await panel(tab.id!, 'type-send', { text: 'First message on the code agent.' });
      const end = Date.now() + 30_000;
      for (;;) {
        const read = await panel(tab.id!, 'read');
        if (read.transcript.includes(DONE_TOKEN)) break;
        assert(Date.now() < end, `the first run never finished: ${read.status}`);
        await sleep(500);
      }
      await sleep(1_000);

      const before = await panel(tab.id!, 'read');
      assert(
        agentLabel(before) === `Agent: ${CODE_NAME}`,
        `the picker should show the code agent, it shows ${agentLabel(before)}`,
      );

      const openMenu = await panel(tab.id!, 'click', { label: CODE_NAME });
      assert(openMenu.ok, 'the agent picker button was not found');
      const pick = await panel(tab.id!, 'click', { label: WORK_NAME });
      assert(pick.ok, `the ${WORK_NAME} item was not found in the agent menu`);

      const switchEnd = Date.now() + 10_000;
      let after = await panel(tab.id!, 'read');
      while (agentLabel(after) !== `Agent: ${WORK_NAME}`) {
        assert(Date.now() < switchEnd, `the picker never switched to the work agent, it shows ${agentLabel(after)}`);
        await sleep(300);
        after = await panel(tab.id!, 'read');
      }

      // The switched conversation still runs; the mock answers an unscripted prompt the same way.
      await panel(tab.id!, 'type-send', { text: 'Second message on the work agent.' });
      const runEnd = Date.now() + 30_000;
      for (;;) {
        const read = await panel(tab.id!, 'read');
        if ((read.transcript.match(new RegExp(DONE_TOKEN, 'g')) ?? []).length >= 2) break;
        assert(Date.now() < runEnd, `the second run never finished: ${read.status}`);
        await sleep(500);
      }

      return { switchedTo: agentLabel(after), transcriptTail: after.transcript.slice(-160) };
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
