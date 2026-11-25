// The permission card against a REAL local OpenCode V2 service: the check creates a /tmp probe project whose
// config makes the service ask before its own bash tool, sends two prompts through the panel, and answers the
// first card Allow and the second Deny. Service-side, each ask must appear in the session's pending list and be
// gone after the answer, and each run must end cleanly. Needs args.url (the service), args.password (its Basic
// auth password, never reported) and args.directory (an absolute /tmp path for the probe project).
import { defineCheck } from './registry';
import { openPanelTab, panel } from './panel-chat';
import { assert, sleep } from './helpers';

const FIXTURES = (import.meta.env.WXT_AUTORUN_URL as string | undefined) ?? 'http://localhost:8787';
const AGENT_ID = 'nb-agent-v2-permission-real';
const CARD_TITLE = 'Allow the agent service to do this?';

interface PendingAsk {
  id: string;
  action: string;
  resources: string[];
}

interface ServiceSession {
  id: string;
  location?: { directory?: string };
  time?: { created?: number };
}

function authHeader(password: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (password) headers.authorization = `Basic ${btoa(`opencode:${password}`)}`;
  return headers;
}

async function serviceFetch(url: string, password: string, path: string): Promise<unknown> {
  const response = await fetch(`${url.replace(/\/$/, '')}/${path}`, { headers: authHeader(password) });
  assert(response.ok, `the service answered ${response.status} for ${path}`);
  return (await response.json()) as unknown;
}

async function listSessions(url: string, password: string, directory: string): Promise<ServiceSession[]> {
  const body = (await serviceFetch(url, password, `api/session?directory=${encodeURIComponent(directory)}`)) as {
    data?: ServiceSession[];
  };
  return (body.data ?? []).filter(s => s.location?.directory === directory);
}

async function pendingAsks(url: string, password: string, sessionId: string): Promise<PendingAsk[]> {
  const body = (await serviceFetch(url, password, `api/session/${encodeURIComponent(sessionId)}/permission`)) as {
    data?: PendingAsk[];
  };
  return body.data ?? [];
}

/** Newest probe-directory session not seen before; the engine opens one session per run. */
async function findRunSession(
  url: string,
  password: string,
  directory: string,
  exclude: string[],
  deadlineMs: number,
): Promise<ServiceSession> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const sessions = await listSessions(url, password, directory);
    const found = sessions
      .filter(s => !exclude.includes(s.id))
      .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0];
    if (found) return found;
    assert(Date.now() < end, 'the engine session never appeared in the service session list');
    await sleep(1_000);
  }
}

async function waitForCard(tabId: number, needle: string, what: string): Promise<void> {
  const end = Date.now() + 120_000;
  let body = '';
  while (Date.now() < end) {
    body = (await panel(tabId, 'read')).body;
    if (body.includes(CARD_TITLE) && body.includes(needle)) return;
    await sleep(500);
  }
  throw new Error(`the permission card for ${what} never opened. Panel body:\n${body.slice(-600)}`);
}

async function waitForReady(tabId: number, what: string, okPattern = /(ready|done)/i): Promise<string> {
  const end = Date.now() + 120_000;
  for (;;) {
    const read = await panel(tabId, 'read');
    if (okPattern.test(read.status)) return read.transcript;
    assert(Date.now() < end, `the run did not end after ${what}. Status: ${read.status}`);
    await sleep(1_500);
  }
}

/** The ask must be pending before the answer, and gone right after it. */
async function assertAskLifecycle(
  url: string,
  password: string,
  sessionId: string,
  command: string,
  answer: 'Allow' | 'Deny',
  tabId: number,
): Promise<PendingAsk> {
  const end = Date.now() + 20_000;
  let asks: PendingAsk[] = [];
  while (Date.now() < end) {
    asks = await pendingAsks(url, password, sessionId);
    if (asks.length > 0) break;
    await sleep(500);
  }
  assert(asks.length === 1, `expected exactly one pending ask for the ${answer} round, got ${JSON.stringify(asks)}`);
  assert(asks[0].id.startsWith('per'), `the ask id is not a permission id: ${asks[0].id}`);
  assert(asks[0].action === 'shell', `the ask action is ${asks[0].action}, expected shell`);
  assert(
    asks[0].resources.some(r => r.includes(command)),
    `the ask resources ${JSON.stringify(asks[0].resources)} do not name the command ${command}`,
  );

  const click = await panel(tabId, 'click', { label: answer });
  assert(click.ok, `the ${answer} button was not found on the permission card`);

  const clearedEnd = Date.now() + 15_000;
  for (;;) {
    if ((await pendingAsks(url, password, sessionId)).length === 0) return asks[0];
    assert(Date.now() < clearedEnd, `the ${answer} answer never reached the service; the ask stayed pending`);
    await sleep(500);
  }
}

export const v2PermissionReal = defineCheck({
  name: 'v2-permission-real',
  title: 'OpenCode V2 permission answers, live service',
  description:
    'Against a real local V2 service: a /tmp probe project (created here) asks for its own bash tool; the panel card is answered Allow once and Deny once; each ask must be pending on the service before the answer and gone after it, and each run must end cleanly.',
  run: async args => {
    const url = String(args.url ?? '');
    const password = String(args.password ?? '');
    const directory = String(args.directory ?? '/tmp/nanobrowser-v2-probe');
    assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(url), 'missing args.url (the live V2 service, a loopback http URL)');
    assert(directory.startsWith('/tmp/'), 'args.directory must be an absolute /tmp path for the probe project');
    const nonce = Math.random().toString(36).slice(2, 8);
    const allowCommand = `echo nbask-${nonce}-a`;
    const denyCommand = `echo nbask-${nonce}-b`;

    const created = (await (
      await fetch(`${FIXTURES}/__v2mock/probe-project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory }),
      })
    ).json()) as { ok?: boolean };
    assert(!!created.ok, `the probe project was not created: ${JSON.stringify(created)}`);

    const savedAgents = (await chrome.storage.local.get('nb.agents'))['nb.agents'] ?? [];
    const savedKeys = (await chrome.storage.local.get('nb.agent-keys'))['nb.agent-keys'] ?? {};
    const savedSettings = (await chrome.storage.local.get('nb.settings'))['nb.settings'] ?? {};
    await chrome.storage.local.set({
      'nb.agents': [
        ...(savedAgents as Array<{ id: string }>).filter(a => a.id !== AGENT_ID),
        { id: AGENT_ID, kind: 'opencode-v2', name: 'OpenCode V2 real permissions', url, directory },
      ],
      'nb.agent-keys': { ...(savedKeys as Record<string, string>), [AGENT_ID]: password },
      'nb.settings': { ...(savedSettings as Record<string, unknown>), defaultAgentId: AGENT_ID },
    });

    const tab = await openPanelTab();
    try {
      const seenSessions: string[] = [];
      const decisions: string[] = [];
      const asksSeen: Array<{ action: string; resources: string[] }> = [];

      await panel(tab.id!, 'type-send', {
        text: `Run the shell command \`${allowCommand}\` with your bash tool. Do exactly this and nothing else.`,
      });
      await waitForCard(tab.id!, allowCommand, 'the allow round');
      const sessionA = await findRunSession(url, password, directory, seenSessions, 30_000);
      seenSessions.push(sessionA.id);
      const askA = await assertAskLifecycle(url, password, sessionA.id, allowCommand, 'Allow', tab.id!);
      asksSeen.push({ action: askA.action, resources: askA.resources });
      decisions.push('once');
      const transcriptA = await waitForReady(tab.id!, 'the allow round');
      assert(
        transcriptA.includes(`nbask-${nonce}-a`),
        `the approved command output never reached the transcript:\n${transcriptA.slice(-400)}`,
      );

      await panel(tab.id!, 'type-send', {
        text: `Run the shell command \`${denyCommand}\` with your bash tool. Do exactly this and nothing else.`,
      });
      await waitForCard(tab.id!, denyCommand, 'the deny round');
      const sessionB = await findRunSession(url, password, directory, seenSessions, 30_000);
      seenSessions.push(sessionB.id);
      const askB = await assertAskLifecycle(url, password, sessionB.id, denyCommand, 'Deny', tab.id!);
      decisions.push('reject');
      asksSeen.push({ action: askB.action, resources: askB.resources });
      // A denied run is stopped by the engine on purpose: the interruption is the clean deny outcome.
      await waitForReady(tab.id!, 'the deny round', /(stopped|done|ready)/i);
      await sleep(1_000);

      const after = await pendingAsks(url, password, sessionB.id);
      assert(after.length === 0, `asks are still pending after both answers: ${JSON.stringify(after)}`);

      return {
        serviceUrl: url,
        sessions: seenSessions,
        decisions,
        asks: asksSeen,
        transcript: transcriptA.slice(-200),
      };
    } finally {
      await chrome.tabs.remove(tab.id!).catch(() => undefined);
      await chrome.storage.local.set({
        'nb.agents': savedAgents,
        'nb.agent-keys': savedKeys,
        'nb.settings': savedSettings,
      });
      await import('@src/store/settings').then(m => void m.settingsStorage.get());
    }
  },
});
