import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectClientMcp, type ClientMcpOptions, type ClientMcpTool } from '../client-mcp';
import { SessionAllowlist } from '../session-allowlist';
import { TransportError } from '../http';
import { LocalServiceUrlError } from '../url-policy';

const sockets: FakeSocket[] = [];

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  url: string;
  sent: string[] = [];
  closedWith: number | undefined;
  #listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  // The real WebSocket always fires open before any traffic; the fake fires it on first use instead. failDial
  // stands for a handshake refused before it ever opened, so it stays silent.
  #opened = false;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  send(data: string): void {
    this.#markOpen();
    this.sent.push(data);
  }

  close(code = 1000, _reason?: string): void {
    this.#markOpen();
    this.closedWith = code;
    this.readyState = 3;
    this.#emit('close');
  }

  serverClose(): void {
    this.#markOpen();
    this.readyState = 3;
    this.#emit('close');
  }

  failDial(): void {
    this.readyState = 3;
    this.#emit('error');
  }

  deliver(text: string): void {
    this.#markOpen();
    this.#deliver({ data: text });
  }

  deliverRaw(data: unknown): void {
    this.#markOpen();
    this.#deliver({ data });
  }

  #markOpen(): void {
    if (this.#opened) return;
    this.#opened = true;
    this.#emit('open');
  }

  #deliver(event: unknown): void {
    for (const listener of this.#listeners.get('message') ?? []) listener(event as MessageEvent);
  }

  #emit(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({} as MessageEvent);
  }
}

function ticketFetch(tickets: string[], failures = 0) {
  let mints = 0;
  const impl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const index = mints++;
    if (index < failures) return new Response('', { status: 403 });
    const ticket = tickets[Math.min(index - failures, tickets.length - 1)];
    return new Response(JSON.stringify({ location: { directory: '/w' }, data: { ticket, expires_in: 60 } }), {
      status: 200,
    });
  });
  return impl;
}

function makeTools(handler: ClientMcpTool['handler']): ClientMcpTool[] {
  return [
    {
      name: 'echo',
      description: 'echo back',
      inputSchema: { properties: { echo: { type: 'string' } } },
      handler,
    },
  ];
}

function connect(overrides: Partial<ClientMcpOptions> & { fetchImpl: ClientMcpOptions['fetchImpl'] }) {
  const sessions = new SessionAllowlist();
  sessions.add('ses_ok');
  const handler = vi.fn(async (args: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: String(args.echo ?? '') }],
  }));
  const options: ClientMcpOptions = {
    baseUrl: 'http://127.0.0.1:49374',
    name: 'nb',
    tools: makeTools(handler),
    sessions,
    socketImpl: url => new FakeSocket(url),
    ...overrides,
  };
  const connection = connectClientMcp(options);
  return { connection, sessions, handler };
}

function sentJson(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map(text => JSON.parse(text) as Record<string, unknown>);
}

beforeEach(() => {
  sockets.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connecting over the client MCP websocket', () => {
  it('mints a ticket first, then opens the exact v2.3.2 URL with it', async () => {
    const fetchImpl = ticketFetch(['T1']);
    connect({ fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://127.0.0.1:49374/api/experimental/client-mcp?name=nb&ticket=T1');
  });

  it('flips an https base to wss and passes the directory and password through', async () => {
    const fetchImpl = ticketFetch(['T1']);
    connect({ baseUrl: 'https://localhost:8443', password: 'pw', directory: '/w d', fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0].url).toBe(
      'wss://localhost:8443/api/experimental/client-mcp?location%5Bdirectory%5D=%2Fw+d&name=nb&ticket=T1',
    );
    const [input, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(String(input)).toBe(
      'https://localhost:8443/api/experimental/client-mcp/token?location%5Bdirectory%5D=%2Fw+d&name=nb',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${btoa('opencode:pw')}`);
  });

  it('fails closed when the ticket cannot be minted, and retries with a fresh one', async () => {
    const onError = vi.fn();
    const fetchImpl = ticketFetch(['T2'], 1);
    connect({ fetchImpl, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(TransportError);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain('ticket=T2');
  });

  it('refuses an unsafe base URL or client name before touching the network', () => {
    const fetchImpl = ticketFetch(['T1']);
    expect(() => connect({ baseUrl: 'https://opencode.ai', fetchImpl })).toThrow(LocalServiceUrlError);
    expect(() => connect({ baseUrl: 'http://127.0.0.1:49374', name: 'bad name!', fetchImpl })).toThrow(TransportError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it('names the real rejection when a handshake is refused, asking the same URL over plain http', async () => {
    const onDialFailure = vi.fn();
    // The mint succeeds once; every later call (the plain-http probe of the socket URL) answers 403.
    let minted = false;
    const impl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (!minted) {
        minted = true;
        return new Response(JSON.stringify({ location: { directory: '/w' }, data: { ticket: 'T1', expires_in: 60 } }), {
          status: 200,
        });
      }
      return new Response('', { status: 403 });
    });
    connect({ fetchImpl: impl, onDialFailure });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    sockets[0].failDial();
    await vi.advanceTimersByTimeAsync(0);
    expect(onDialFailure).toHaveBeenCalledTimes(1);
    expect(onDialFailure.mock.calls[0][0]).toContain('403');
    const probeUrl = String(vi.mocked(impl).mock.calls[1][0]);
    expect(probeUrl).toContain('/api/experimental/client-mcp?');
    expect(probeUrl).not.toContain('/token');
  });

  it('reports a dial failure once per attempt, and again for the next attempt', async () => {
    const onDialFailure = vi.fn();
    const fetchImpl = ticketFetch(['T1', 'T2']);
    connect({ fetchImpl, onDialFailure });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].failDial();
    await vi.advanceTimersByTimeAsync(0);
    expect(onDialFailure).toHaveBeenCalledTimes(1);
    // The reconnect's own dial failure reports again for its own attempt, not for the first.
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    sockets[1].failDial();
    await vi.advanceTimersByTimeAsync(0);
    expect(onDialFailure).toHaveBeenCalledTimes(2);
  });

  it('names a mint failure with the transport message', async () => {
    const onDialFailure = vi.fn();
    const fetchImpl = ticketFetch(['T2'], 1);
    connect({ fetchImpl, onDialFailure });
    await vi.advanceTimersByTimeAsync(0);
    expect(onDialFailure).toHaveBeenCalledTimes(1);
    expect(onDialFailure.mock.calls[0][0]).toContain('403');
  });

  it('answers initialize by echoing the offered protocol version', async () => {
    const fetchImpl = ticketFetch(['T1']);
    connect({ fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].deliver(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sentJson(sockets[0])).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'nb', version: '1.0.0' },
        },
      },
    ]);
    sockets[0].deliver(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sentJson(sockets[0])[1].result).toMatchObject({ protocolVersion: '2025-11-25' });
  });

  it('answers ping and lists the tools with an object input schema', async () => {
    const fetchImpl = ticketFetch(['T1']);
    connect({ fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].deliver(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
    sockets[0].deliver(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }));
    await vi.advanceTimersByTimeAsync(0);
    const replies = sentJson(sockets[0]);
    expect(replies[0]).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect(replies[1]).toEqual({
      jsonrpc: '2.0',
      id: 8,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'echo back',
            inputSchema: { type: 'object', properties: { echo: { type: 'string' } } },
          },
        ],
      },
    });
  });

  it('runs a tool call only for a session on the allowlist, passing the session ID through', async () => {
    const fetchImpl = ticketFetch(['T1']);
    const { handler } = connect({ fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].deliver(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'echo', arguments: { echo: 'hi' }, _meta: { 'ai.opencode/sessionID': 'ses_ok' } },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledWith({ echo: 'hi' }, { sessionID: 'ses_ok' });
    expect(sentJson(sockets[0])).toEqual([
      { jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: 'hi' }], isError: undefined } },
    ]);
  });

  it('refuses tool calls from other sessions, missing sessions, even for unknown tools', async () => {
    const fetchImpl = ticketFetch(['T1']);
    const { handler } = connect({ fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].deliver(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'echo', arguments: {}, _meta: { 'ai.opencode/sessionID': 'ses_other' } },
      }),
    );
    sockets[0].deliver(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'nope', arguments: {}, _meta: {} },
      }),
    );
    sockets[0].deliver(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'echo' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    const replies = sentJson(sockets[0]);
    expect(replies).toHaveLength(3);
    for (const reply of replies) {
      const result = reply.result as { isError: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('refused');
    }
  });

  it('answers an allowed session that calls an unknown tool with the JSON-RPC error', async () => {
    const fetchImpl = ticketFetch(['T1']);
    const { handler } = connect({ fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].deliver(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'nope', _meta: { 'ai.opencode/sessionID': 'ses_ok' } },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    expect(sentJson(sockets[0])).toEqual([
      { jsonrpc: '2.0', id: 13, error: { code: -32602, message: 'Unknown tool: nope' } },
    ]);
  });

  it('turns a thrown handler into an isError result, and unknown methods into -32601', async () => {
    const fetchImpl = ticketFetch(['T1']);
    const boom = vi.fn(async () => {
      throw new Error('kaput');
    });
    connect({ fetchImpl, tools: makeTools(boom) });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].deliver(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'echo', _meta: { 'ai.opencode/sessionID': 'ses_ok' } },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sentJson(sockets[0])).toEqual([
      {
        jsonrpc: '2.0',
        id: 14,
        result: { content: [{ type: 'text', text: 'kaput' }], isError: true },
      },
    ]);
    sockets[0].deliver(JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'resources/list' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sentJson(sockets[0])[1]).toEqual({
      jsonrpc: '2.0',
      id: 15,
      error: { code: -32601, message: 'Method not found: resources/list' },
    });
  });

  it('ignores notifications without an ID, responses, broken JSON and binary frames', async () => {
    const fetchImpl = ticketFetch(['T1']);
    connect({ fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].deliver(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    sockets[0].deliver(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    sockets[0].deliver('{broken');
    sockets[0].deliver('[]');
    sockets[0].deliverRaw(new Uint8Array([1, 2]));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0].sent).toEqual([]);
  });

  it('reconnects with backoff, a fresh single-use ticket each time, and resets after initialize', async () => {
    const onReady = vi.fn();
    const fetchImpl = ticketFetch(['T1', 'T2', 'T3', 'T4']);
    const { connection } = connect({ fetchImpl, onReady });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0].url).toContain('ticket=T1');
    sockets[0].serverClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets[1].url).toContain('ticket=T2');
    sockets[1].serverClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets[2].url).toContain('ticket=T3');
    expect(onReady).not.toHaveBeenCalled();
    sockets[2].deliver(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onReady).toHaveBeenCalledTimes(1);
    sockets[2].serverClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets[3].url).toContain('ticket=T4');
    connection.close();
    sockets[3].serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('close() stops everything and closes the open socket', async () => {
    const fetchImpl = ticketFetch(['T1']);
    const { connection } = connect({ fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    connection.close();
    expect(sockets[0].closedWith).toBe(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });
});
