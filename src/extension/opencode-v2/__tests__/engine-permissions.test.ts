// The engine's permission handling against a mocked OpenCode service: asks reach the user with the session's
// payload, answers map to replies, other sessions and malformed asks are ignored, a server reply aborts the
// pending ask, a reconnect replays the stored list, and every failure while the run is live ends the run loudly.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@src/browser-control';
import type * as openCodeV2 from '@src/opencode-v2';
import {
  connectService,
  createSession,
  interruptSession,
  listModels,
  listSessionPermissions,
  promptSession,
  replySessionPermission,
  resolveLocation,
} from '@src/opencode-v2';
import type { PanelEventBody } from '@src/ui/protocol';
import { runV2Turn, type V2TurnOptions } from '../engine';

const BASE = 'http://127.0.0.1:41299';
const SERVER_INFO = {
  version: '0.0.0-test',
  pid: 1,
  hostname: null,
  urls: [BASE],
  paths: { tmp: '/tmp' },
  capabilities: null,
};

const harness = vi.hoisted(() => ({
  sessionId: 'ses_engine',
  onEvent: null as null | ((event: { type: string; sessionID?: string; [key: string]: unknown }) => void),
}));

vi.mock('@src/opencode-v2', async importOriginal => {
  const actual = (await importOriginal()) as typeof openCodeV2;
  return {
    ...actual,
    connectService: vi.fn(async () => SERVER_INFO),
    resolveLocation: vi.fn(async () => '/work'),
    createSession: vi.fn(async () => harness.sessionId),
    promptSession: vi.fn(async () => undefined),
    interruptSession: vi.fn(async () => true),
    listModels: vi.fn(async () => []),
    listSessionPermissions: vi.fn(async () => []),
    replySessionPermission: vi.fn(async () => undefined),
    subscribeEvents: vi.fn((options: { onEvent: (event: { type: string }) => void }) => {
      harness.onEvent = options.onEvent;
      return { close: vi.fn() };
    }),
    connectClientMcp: vi.fn((options: { onReady?: () => void }) => {
      options.onReady?.();
      return { ping: vi.fn(), close: vi.fn() };
    }),
  };
});

beforeEach(() => {
  harness.onEvent = null;
  vi.mocked(connectService).mockImplementation(async () => SERVER_INFO);
  vi.mocked(resolveLocation).mockImplementation(async () => '/work');
  vi.mocked(createSession).mockImplementation(async () => harness.sessionId);
  vi.mocked(promptSession).mockImplementation(async () => undefined);
  vi.mocked(interruptSession).mockImplementation(async () => true);
  vi.mocked(listModels).mockImplementation(async () => []);
  vi.mocked(listSessionPermissions).mockImplementation(async () => []);
  vi.mocked(replySessionPermission).mockImplementation(async () => undefined);
});

interface Ask {
  data: Record<string, unknown>;
  signal: AbortSignal;
}

function setup() {
  const asks: Ask[] = [];
  let answer: () => unknown = () => 'approve';
  const emit = vi.fn<(event: PanelEventBody) => void>();
  const signal = new AbortController();
  const requestPermission = vi.fn(async (data: Record<string, unknown>, askSignal: AbortSignal) => {
    asks.push({ data, signal: askSignal });
    return answer();
  });
  const options: V2TurnOptions = {
    conversationId: 'conv-1',
    runId: 'run-1',
    text: 'tidy the page',
    turnCap: 3,
    layer: { call: vi.fn() } as unknown as Session,
    border: undefined,
    signal: signal.signal,
    emit,
    requestPermission,
    service: {
      url: BASE,
      password: 'secret',
      directory: '/work',
      model: { providerID: 'prov', modelID: 'model' },
    },
  };
  const start = () => {
    const done = runV2Turn(options);
    const subscribed = vi.waitFor(() => {
      if (!harness.onEvent) throw new Error('the event stream is not subscribed yet');
    });
    // subscribed is awaited by the test; done is awaited only after the test ends the run.
    return { done, subscribed };
  };
  const send = (event: { type: string; [key: string]: unknown }) => harness.onEvent!(event);
  const finishOk = () => send({ type: 'session.execution.succeeded', sessionID: harness.sessionId });
  return {
    options,
    asks,
    ask: requestPermission,
    emit,
    signal,
    start,
    send,
    finishOk,
    setAnswer: (next: () => unknown) => {
      answer = next;
    },
  };
}

/** A pending ask whose answer the test releases by hand. */
function heldAnswer(setup2: ReturnType<typeof setup>) {
  let release: (value: unknown) => void = () => undefined;
  setup2.setAnswer(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  return (value: unknown) => release(value);
}

const askEvent = (id: string, overrides: Record<string, unknown> = {}) => ({
  type: 'permission.asked',
  sessionID: harness.sessionId,
  id,
  action: 'browser_click',
  resources: ['element://btn-7'],
  ...overrides,
});

describe('runV2Turn permission handling', () => {
  it('asks the user for a session permission and replies once for approve', async () => {
    const t = setup();
    const run = t.start();
    await run.subscribed;
    t.send(askEvent('per_click'));

    await vi.waitFor(() => expect(vi.mocked(replySessionPermission)).toHaveBeenCalledTimes(1));
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(t.asks[0].data).toEqual({ action: 'browser_click', resources: ['element://btn-7'], canRemember: false });
    expect(t.asks[0].signal).toBeInstanceOf(AbortSignal);
    expect(t.asks[0].signal.aborted).toBe(false);
    expect(vi.mocked(replySessionPermission).mock.calls[0][0]).toEqual({
      baseUrl: BASE,
      password: 'secret',
      sessionId: harness.sessionId,
      requestId: 'per_click',
      decision: 'once',
    });

    t.finishOk();
    const end = await run.done;
    expect(end).toMatchObject({ status: 'done', outcome: 'success', turns: 0 });
    expect(t.emit.mock.calls.map(([event]) => event.type)).toEqual(['agent_start', 'agent_end']);
    expect(vi.mocked(promptSession).mock.calls[0][0]).toMatchObject({
      sessionId: harness.sessionId,
      text: 'tidy the page',
    });
  });

  it.each([['decline'], ['approve-remember'], [undefined]])('replies reject for the answer %j', async answer => {
    const t = setup();
    t.setAnswer(() => answer);
    const run = t.start();
    await run.subscribed;
    t.send(askEvent('per_decline'));

    await vi.waitFor(() => expect(vi.mocked(replySessionPermission)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(replySessionPermission).mock.calls[0][0]).toMatchObject({
      requestId: 'per_decline',
      decision: 'reject',
    });

    t.finishOk();
    await run.done;
  });

  it('ignores asks from other sessions, malformed asks and duplicate ids', async () => {
    const t = setup();
    const run = t.start();
    await run.subscribed;
    t.send(askEvent('per_1', { sessionID: 'ses_other' }));
    t.send(askEvent('bad_1'));
    t.send(askEvent('per_dup', { action: 'read', resources: [] }));
    t.send(askEvent('per_dup', { action: 'read', resources: [] }));
    await vi.waitFor(() => expect(vi.mocked(replySessionPermission)).toHaveBeenCalledTimes(1));
    t.finishOk();

    await run.done;
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replySessionPermission)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replySessionPermission).mock.calls[0][0]).toMatchObject({
      requestId: 'per_dup',
      decision: 'once',
    });
  });

  it('aborts the pending ask when the server replies first, and sends no reply of its own', async () => {
    const t = setup();
    const release = heldAnswer(t);
    const run = t.start();
    await run.subscribed;
    t.send(askEvent('per_reply', { action: 'write' }));
    expect(t.asks).toHaveLength(1);

    t.send({ type: 'permission.replied', sessionID: harness.sessionId, requestID: 'per_reply' });
    expect(t.asks[0].signal.aborted).toBe(true);

    release('approve');
    t.finishOk();
    await run.done;
    expect(vi.mocked(replySessionPermission)).not.toHaveBeenCalled();
  });

  it('does not abort the pending ask for a replied event of another session or an unknown request', async () => {
    const t = setup();
    const release = heldAnswer(t);
    const run = t.start();
    await run.subscribed;
    t.send({ type: 'permission.replied', sessionID: harness.sessionId, requestID: 'per_unknown' });
    t.send(askEvent('per_live', { action: 'write' }));
    t.send({ type: 'permission.replied', sessionID: 'ses_other', requestID: 'per_live' });
    expect(t.asks[0].signal.aborted).toBe(false);

    release('approve');
    await vi.waitFor(() => expect(vi.mocked(replySessionPermission)).toHaveBeenCalledTimes(1));
    t.finishOk();
    await run.done;
    expect(vi.mocked(replySessionPermission).mock.calls[0][0]).toMatchObject({
      requestId: 'per_live',
      decision: 'once',
    });
  });

  it('replays the stored permission list on server.connected and skips other sessions', async () => {
    const t = setup();
    const run = t.start();
    await run.subscribed;
    vi.mocked(listSessionPermissions).mockResolvedValue([
      { id: 'per_a', sessionID: harness.sessionId, action: 'browser_click', resources: ['element://a'] },
      { id: 'per_other', sessionID: 'ses_other', action: 'write', resources: [] },
      { id: 'per_b', sessionID: harness.sessionId, action: 'fill', resources: [] },
    ]);

    t.send({ type: 'server.connected' });
    await vi.waitFor(() => expect(t.asks).toHaveLength(2));
    t.finishOk();

    const end = await run.done;
    expect(end).toMatchObject({ status: 'done' });
    expect(vi.mocked(listSessionPermissions).mock.calls[0][0]).toEqual({
      baseUrl: BASE,
      password: 'secret',
      sessionId: harness.sessionId,
    });
    expect(t.asks.map(a => a.data)).toEqual([
      { action: 'browser_click', resources: ['element://a'], canRemember: false },
      { action: 'fill', resources: [], canRemember: false },
    ]);
    expect(vi.mocked(replySessionPermission).mock.calls.map(([call]) => call.requestId)).toEqual(['per_a', 'per_b']);
  });

  it('fails the run when the permission listing cannot be read', async () => {
    const t = setup();
    const run = t.start();
    await run.subscribed;
    vi.mocked(listSessionPermissions).mockRejectedValue(new Error('listing failed'));

    t.send({ type: 'server.connected' });
    await expect(run.done).rejects.toThrow('listing failed');
    expect(t.ask).not.toHaveBeenCalled();
    expect(vi.mocked(replySessionPermission)).not.toHaveBeenCalled();
  });

  it('fails the run when the reply fails', async () => {
    const t = setup();
    const run = t.start();
    await run.subscribed;
    vi.mocked(replySessionPermission).mockRejectedValue(new Error('the reply did not land'));

    t.send(askEvent('per_fail', { action: 'write' }));
    await expect(run.done).rejects.toThrow('the reply did not land');
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replySessionPermission)).toHaveBeenCalledTimes(1);
    // A failed permission interrupts the session and still ends the turn cleanly for the panel.
    expect(vi.mocked(interruptSession)).toHaveBeenCalled();
    expect(t.emit.mock.calls.map(([event]) => event.type)).toContain('agent_end');
  });

  it('fails the run when asking the user fails', async () => {
    const t = setup();
    const run = t.start();
    await run.subscribed;
    t.setAnswer(() => Promise.reject(new Error('the panel went away')));

    t.send(askEvent('per_throw', { action: 'write' }));
    await expect(run.done).rejects.toThrow('the panel went away');
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replySessionPermission)).not.toHaveBeenCalled();
  });

  it('swallows a permission failure after the run finished', async () => {
    const t = setup();
    const run = t.start();
    await run.subscribed;
    t.setAnswer(() => Promise.reject(new Error('the panel went away')));

    t.send(askEvent('per_late', { action: 'write' }));
    t.finishOk();

    const end = await run.done;
    expect(end).toMatchObject({ status: 'done', outcome: 'success' });
    expect(t.emit.mock.calls.map(([event]) => event.type)).toEqual(['agent_start', 'agent_end']);
  });

  it('aborts a pending ask when the run finishes, and answers nothing afterwards', async () => {
    const t = setup();
    const release = heldAnswer(t);
    const run = t.start();
    await run.subscribed;
    t.send(askEvent('per_pending', { action: 'write' }));
    expect(t.asks).toHaveLength(1);

    t.finishOk();
    expect(t.asks[0].signal.aborted).toBe(true);
    release('approve');

    const end = await run.done;
    expect(end).toMatchObject({ status: 'done' });
    expect(vi.mocked(replySessionPermission)).not.toHaveBeenCalled();
  });

  it('aborts a pending ask when the run is stopped, answers nothing, and ends stopped', async () => {
    const t = setup();
    const release = heldAnswer(t);
    const run = t.start();
    await run.subscribed;
    t.send(askEvent('per_stop', { action: 'write' }));
    expect(t.asks).toHaveLength(1);

    t.signal.abort();
    await vi.waitFor(() => expect(vi.mocked(interruptSession)).toHaveBeenCalledTimes(1));
    release('approve');
    t.send({ type: 'session.execution.interrupted', sessionID: harness.sessionId });

    const end = await run.done;
    expect(end).toMatchObject({ status: 'stopped' });
    expect(t.asks[0].signal.aborted).toBe(true);
    expect(vi.mocked(replySessionPermission)).not.toHaveBeenCalled();
  });
});
