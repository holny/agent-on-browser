import { describe, expect, it } from 'vitest';
import { subscribeEvents } from '../events';

const BASE = 'http://localhost:49374';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fetchReturning(chunks: string[]): typeof fetch {
  return (async () => sseResponse(chunks)) as unknown as typeof fetch;
}

describe('subscribeEvents', () => {
  it('unwraps the v2 envelope: payload fields arrive at the top level', async () => {
    const seen: Array<{ type: string; sessionID?: string; delta?: string }> = [];
    const done = new Promise<void>(resolve => {
      subscribeEvents({
        baseUrl: BASE,
        fetchImpl: fetchReturning([
          'data: {"id":"e1","created":1,"type":"server.connected","data":{}}\n\n',
          'data: {"id":"e2","created":2,"type":"session.text.delta","data":{"sessionID":"ses_1","delta":"你好"}}\n\n',
          'data: {"id":"e3","created":3,"type":"session.execution.succeeded","data":{"sessionID":"ses_1"}}\n\n',
        ]),
        onEvent: event => {
          seen.push(event as { type: string; sessionID?: string; delta?: string });
          if (event.type === 'session.execution.succeeded') resolve();
        },
      });
    });
    await done;
    expect(seen[0].type).toBe('server.connected');
    expect(seen[1]).toMatchObject({ type: 'session.text.delta', sessionID: 'ses_1', delta: '你好' });
    expect(seen[2]).toMatchObject({ type: 'session.execution.succeeded', sessionID: 'ses_1' });
  });

  it('parses data frames and dispatches typed events in order', async () => {
    const seen: string[] = [];
    const done = new Promise<void>(resolve => {
      subscribeEvents({
        baseUrl: BASE,
        fetchImpl: fetchReturning([
          'data: {"id":"e1","created":1,"type":"server.connected","data":{}}\n\n',
          'data: {"id":"e2","created":2,"type":"session.text.delta","data":{"sessionID":"ses_1","delta":"你好"}}\n\n',
          'data: {"id":"e3","created":3,"type":"session.execution.succeeded","data":{"sessionID":"ses_1"}}\n\n',
        ]),
        onEvent: event => {
          seen.push(event.type);
          if (event.type === 'session.execution.succeeded') resolve();
        },
      });
    });
    await done;
    expect(seen).toEqual(['server.connected', 'session.text.delta', 'session.execution.succeeded']);
  });

  it('joins multi-line data frames per the SSE format', async () => {
    const seen: string[] = [];
    const done = new Promise<void>(resolve => {
      subscribeEvents({
        baseUrl: BASE,
        fetchImpl: fetchReturning(['data: {"type":"a",\ndata: "payload":1}\n\n']),
        onEvent: event => {
          seen.push(event.type);
          resolve();
        },
      });
    });
    await done;
    expect(seen).toEqual(['a']);
  });

  it('skips comments and malformed frames without dispatching', async () => {
    const seen: string[] = [];
    const done = new Promise<void>(resolve => {
      subscribeEvents({
        baseUrl: BASE,
        fetchImpl: fetchReturning([': heartbeat\n\ndata: not json\n\ndata: {"type":"good"}\n\n']),
        onEvent: event => {
          seen.push(event.type);
          if (event.type === 'good') resolve();
        },
      });
    });
    await done;
    await new Promise(r => setTimeout(r, 20));
    expect(seen.filter(t => t === 'good')).toEqual(['good']);
    expect(seen).not.toContain('not json');
  });

  it('announces stream.ended once the body ends and close is idempotent', async () => {
    const types: string[] = [];
    const done = new Promise<void>(resolve => {
      subscribeEvents({
        baseUrl: BASE,
        fetchImpl: fetchReturning(['data: {"type":"server.connected"}\n\n']),
        onEvent: event => {
          types.push(event.type);
          if (event.type === 'stream.ended') resolve();
        },
      });
    });
    await done;
    expect(types).toEqual(['server.connected', 'stream.ended']);
  });

  it('sends the basic authorization header when a password is set', async () => {
    const calls: Array<Headers | undefined> = [];
    const fetchImpl = (async (_url: URL | string, init?: RequestInit) => {
      calls.push(init?.headers as Headers | undefined);
      return sseResponse([]);
    }) as unknown as typeof fetch;
    subscribeEvents({ baseUrl: BASE, password: 'pw', fetchImpl, onEvent: () => undefined });
    await new Promise(r => setTimeout(r, 10));
    expect(calls[0]?.get('authorization')).toMatch(/^Basic /);
  });

  it('aborts the stream when the caller aborts its signal', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"server.connected"}\n\n'));
      },
    });
    const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const controller = new AbortController();
    const ended = new Promise<void>(resolve => {
      subscribeEvents({
        baseUrl: BASE,
        fetchImpl,
        signal: controller.signal,
        onEvent: event => {
          if (event.type === 'stream.ended') resolve();
        },
      });
    });
    controller.abort();
    await ended;
  });
});

describe('subscribeEvents error handling', () => {
  it('ends quietly when the server refuses the stream', async () => {
    const seen: string[] = [];
    const done = new Promise<void>(resolve => {
      subscribeEvents({
        baseUrl: BASE,
        fetchImpl: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch,
        onEvent: event => {
          seen.push(event.type);
          if (event.type === 'stream.ended') resolve();
        },
      });
    });
    await done;
    expect(seen).toEqual(['stream.ended']);
  });
});
