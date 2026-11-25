// The OpenCode V2 engine, end to end: the panel sends a message, the engine hands it to the local OpenCode V2
// service, that service calls the browser tools this extension attaches over client MCP, and the reply lands in
// the transcript. Needs a reachable V2 service (args.url) whose cors allows this build's origin.
import { defineCheck } from './registry';
import { openPanelTab, panel } from './panel-chat';
import { sleep } from './helpers';
import { BUILTIN_AGENT_ID, settingsStorage } from '@src/store/settings';

const READ_TIMEOUT_MS = 180_000;

export const v2Engine = defineCheck({
  name: 'v2-engine',
  title: 'OpenCode V2 engine',
  description: 'A panel message runs on the local OpenCode V2 service and drives the browser through client MCP.',
  run: async args => {
    const url = String(args.url ?? 'http://127.0.0.1:49374');
    const directory = String(args.directory ?? '');
    const prompt = String(
      args.prompt ??
        '请先用 tabs 工具打开网址 http://127.0.0.1:8787/，再用 snapshot 观察打开的页面，把页面标题原样告诉我。不要做其他事。',
    );
    if (!directory) return { ok: false, error: 'missing args.directory (an absolute path that exists)' };
    const origin = `chrome-extension://${chrome.runtime.id}`;

    const agentId = 'nb-agent-v2';
    const agents = ((await chrome.storage.local.get('nb.agents'))['nb.agents'] ?? []) as Array<{
      id: string;
      kind: 'opencode-v2';
      name: string;
      url: string;
      directory: string;
    }>;
    await chrome.storage.local.set({
      'nb.agents': [
        ...agents.filter(a => a.id !== agentId),
        { id: agentId, kind: 'opencode-v2', name: 'OpenCode V2', url, directory },
      ],
      'nb.agent-keys': {
        ...((await chrome.storage.local.get('nb.agent-keys'))['nb.agent-keys'] ?? {}),
        [agentId]: String(args.password ?? ''),
      },
      'nb.settings': {
        ...((await chrome.storage.local.get('nb.settings'))['nb.settings'] ?? {}),
        defaultAgentId: agentId,
      },
    });
    try {
      const page = await chrome.tabs.create({ url: 'http://localhost:8787/', active: false });
      const tab = await openPanelTab();
      await sleep(400);
      const before = await panel(tab.id!, 'read');
      const sent = await panel(tab.id!, 'type-send', { text: prompt });
      await sleep(2000);
      const after = await panel(tab.id!, 'read');

      const deadline = Date.now() + READ_TIMEOUT_MS;
      let transcript = '';
      let status = '';
      for (;;) {
        await sleep(3000);
        const read = await panel(tab.id!, 'read');
        transcript = read.transcript ?? '';
        status = read.status ?? '';
        if (Date.now() > deadline) break;
        // 回合结束：状态从 Working 回到 Ready，且文字已出现在 transcript 里。
        if (/ready/i.test(status) && transcript.length > 0) break;
      }
      const title = await chrome.tabs.get(page.id!).then(t => t.title ?? '');
      await chrome.tabs.remove(page.id!).catch(() => undefined);
      await chrome.tabs.remove(tab.id!).catch(() => undefined);
      const pass = /Dashboard|Fixtures|标题/i.test(transcript) && transcript.length > 0;
      return {
        ok: pass,
        origin,
        serviceUrl: url,
        directory,
        fixtureTitle: title,
        status,
        sentOk: sent.ok,
        inputBefore: { disabled: before.inputDisabled, buttons: before.disabled },
        inputAfter: { disabled: after.inputDisabled, value: after.input, disabled2: after.disabled },
        transcript: transcript.slice(-800),
      };
    } finally {
      // 还原内置引擎，别的检查不受这次设置影响。
      await settingsStorage.set(s => ({ ...s, defaultAgentId: BUILTIN_AGENT_ID }));
      await import('@src/store/settings').then(m => void m.settingsStorage.get());
    }
  },
});
