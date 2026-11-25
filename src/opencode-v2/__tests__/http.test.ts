import { describe, expect, it, vi } from 'vitest';
import {
  basicAuthorization,
  connectService,
  mintClientTicket,
  TICKET_HEADER,
  TICKET_HEADER_VALUE,
  TransportError,
  type HttpOptions,
} from '../http';
import { LocalServiceUrlError } from '../url-policy';

const INFO = {
  version: 'v2.3.2',
  pid: 4242,
  hostname: 'mac',
  urls: ['http://127.0.0.1:49374'],
  paths: { tmp: '/tmp' },
  capabilities: { persistentPty: true },
};

const TOKEN = { location: { directory: '/w' }, data: { ticket: 'T1', expires_in: 60 } };

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function recordFetch(responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return responder(url, init);
  });
  return { impl, calls };
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('basic authorization', () => {
  it('uses the fixed opencode username', () => {
    expect(basicAuthorization('pw')).toBe(`Basic ${btoa('opencode:pw')}`);
  });
});

describe('connecting to an existing service', () => {
  it('reads GET /api/info and validates the body', async () => {
    const { impl, calls } = recordFetch(() => ok(INFO));
    const info = await connectService({ baseUrl: 'http://127.0.0.1:49374', fetchImpl: impl });
    expect(info).toEqual(INFO);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:49374/api/info');
    expect(calls[0].init?.method).toBe('GET');
    expect(header(calls[0].init, 'authorization')).toBeNull();
  });

  it('sends Basic auth when a password is set, and none when it is empty', async () => {
    const withPassword = recordFetch(() => ok(INFO));
    await connectService({ baseUrl: 'http://localhost:49374', password: 'pw', fetchImpl: withPassword.impl });
    expect(header(withPassword.calls[0].init, 'authorization')).toBe(basicAuthorization('pw'));

    const withoutPassword = recordFetch(() => ok(INFO));
    await connectService({ baseUrl: 'http://localhost:49374', password: '', fetchImpl: withoutPassword.impl });
    expect(header(withoutPassword.calls[0].init, 'authorization')).toBeNull();
  });

  it('refuses a non-local base URL before any request', async () => {
    const { impl, calls } = recordFetch(() => ok(INFO));
    const options: HttpOptions = { baseUrl: 'https://opencode.ai', fetchImpl: impl };
    await expect(connectService(options)).rejects.toBeInstanceOf(LocalServiceUrlError);
    expect(calls).toHaveLength(0);
  });

  it('fails closed on an HTTP error, a network failure, a timeout and a bad body', async () => {
    const status = recordFetch(() => new Response('', { status: 401 }));
    const http = await connectService({ baseUrl: 'http://127.0.0.1:49374', fetchImpl: status.impl }).catch(e => e);
    expect(http).toBeInstanceOf(TransportError);
    expect(http.failure).toBe('http');
    expect(http.status).toBe(401);

    const network = recordFetch(() => {
      throw new TypeError('fetch failed');
    });
    const unreachable = await connectService({ baseUrl: 'http://127.0.0.1:49374', fetchImpl: network.impl }).catch(
      e => e,
    );
    expect(unreachable).toBeInstanceOf(TransportError);
    expect(unreachable.failure).toBe('network');

    const slow = recordFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const timedOut = await connectService({ baseUrl: 'http://127.0.0.1:49374', fetchImpl: slow.impl }).catch(e => e);
    expect(timedOut).toBeInstanceOf(TransportError);
    expect(timedOut.failure).toBe('timeout');

    const malformed = recordFetch(() => ok({ version: 1 }));
    const badBody = await connectService({ baseUrl: 'http://127.0.0.1:49374', fetchImpl: malformed.impl }).catch(
      e => e,
    );
    expect(badBody).toBeInstanceOf(TransportError);
    expect(badBody.failure).toBe('invalid-response');

    const notJson = recordFetch(() => new Response('<html>', { status: 200 }));
    const badJson = await connectService({ baseUrl: 'http://127.0.0.1:49374', fetchImpl: notJson.impl }).catch(e => e);
    expect(badJson).toBeInstanceOf(TransportError);
    expect(badJson.failure).toBe('invalid-response');

    const negativePid = recordFetch(() => ok({ ...INFO, pid: -1 }));
    const badPid = await connectService({ baseUrl: 'http://127.0.0.1:49374', fetchImpl: negativePid.impl }).catch(
      e => e,
    );
    expect(badPid).toBeInstanceOf(TransportError);
    expect(badPid.failure).toBe('invalid-response');
  });
});

describe('minting the client MCP ticket', () => {
  it('POSTs the token endpoint with the forced preflight header, the name and the location', async () => {
    const { impl, calls } = recordFetch(() => ok(TOKEN));
    const ticket = await mintClientTicket({
      baseUrl: 'http://127.0.0.1:49374',
      password: 'pw',
      name: 'nb',
      directory: '/w',
      fetchImpl: impl,
    });
    expect(ticket).toEqual({ ticket: 'T1', expires_in: 60 });
    expect(calls[0].url).toBe(
      'http://127.0.0.1:49374/api/experimental/client-mcp/token?location%5Bdirectory%5D=%2Fw&name=nb',
    );
    expect(calls[0].init?.method).toBe('POST');
    expect(header(calls[0].init, TICKET_HEADER)).toBe(TICKET_HEADER_VALUE);
    expect(header(calls[0].init, 'authorization')).toBe(basicAuthorization('pw'));
  });

  it('omits the location query without a directory', async () => {
    const { impl, calls } = recordFetch(() => ok(TOKEN));
    await mintClientTicket({ baseUrl: 'http://localhost:1', name: 'nb', fetchImpl: impl });
    expect(calls[0].url).toBe('http://localhost:1/api/experimental/client-mcp/token?name=nb');
  });

  it('refuses an off-pattern client name before any request', async () => {
    const { impl, calls } = recordFetch(() => ok(TOKEN));
    const error = await mintClientTicket({ baseUrl: 'http://localhost:1', name: 'bad name!', fetchImpl: impl }).catch(
      e => e,
    );
    expect(error).toBeInstanceOf(TransportError);
    expect(error.failure).toBe('invalid-name');
    expect(calls).toHaveLength(0);
  });

  it('fails closed on a forbidden mint and on a ticket that is not a ticket', async () => {
    const forbidden = recordFetch(() => new Response('', { status: 403 }));
    const error = await mintClientTicket({
      baseUrl: 'http://localhost:1',
      name: 'nb',
      fetchImpl: forbidden.impl,
    }).catch(e => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.failure).toBe('http');
    expect(error.status).toBe(403);

    for (const body of [
      { location: { directory: '/w' }, data: { ticket: '', expires_in: 60 } },
      { location: { directory: '/w' }, data: { ticket: 'T1', expires_in: 0 } },
      { location: { directory: '/w' }, data: { ticket: 'T1', expires_in: 1.5 } },
      { data: { ticket: 'T1', expires_in: 60 } },
    ]) {
      const bad = recordFetch(() => ok(body));
      const invalid = await mintClientTicket({ baseUrl: 'http://localhost:1', name: 'nb', fetchImpl: bad.impl }).catch(
        e => e,
      );
      expect(invalid).toBeInstanceOf(TransportError);
      expect(invalid.failure).toBe('invalid-response');
    }
  });
});
