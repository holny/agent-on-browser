import { describe, expect, it } from 'vitest';
import { listSessionPermissions, replySessionPermission, PERMISSION_REPLIES } from '../permissions';
import { TransportError } from '../http';

const BASE = 'http://localhost:49374';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recordingFetch(log: Array<{ url: string; init?: RequestInit }>, respond: (url: string) => Response) {
  return (async (url: URL | string, init?: RequestInit) => {
    const text = String(url);
    log.push({ url: text, init });
    return respond(text);
  }) as unknown as typeof fetch;
}

const fullRequest = {
  id: 'per_1',
  sessionID: 'ses_1',
  action: 'browser_click',
  resources: ['element://btn-7'],
  save: ['browser_click'],
  metadata: { selector: '#submit' },
  source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
  message: 'Allow clicking the submit button?',
};

describe('listSessionPermissions', () => {
  it('gets the session permission path and unwraps data', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => jsonResponse({ data: [fullRequest] }));
    const requests = await listSessionPermissions({ baseUrl: BASE, fetchImpl, sessionId: 'ses_1' });
    expect(requests).toEqual([fullRequest]);
    expect(new URL(log[0].url).pathname).toBe('/api/session/ses_1/permission');
    expect(new URL(log[0].url).search).toBe('');
    expect(log[0].init?.method).toBe('GET');
  });

  it('keeps a request with only the required fields', async () => {
    const fetchImpl = recordingFetch([], () =>
      jsonResponse({ data: [{ id: 'per_2', sessionID: 'ses_1', action: 'read', resources: [] }] }),
    );
    await expect(listSessionPermissions({ baseUrl: BASE, fetchImpl, sessionId: 'ses_1' })).resolves.toEqual([
      { id: 'per_2', sessionID: 'ses_1', action: 'read', resources: [] },
    ]);
  });

  it('url-encodes the session id in the path', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => jsonResponse({ data: [] }));
    await listSessionPermissions({ baseUrl: BASE, fetchImpl, sessionId: 'ses/1' });
    expect(log[0].url).toBe(`${BASE}/api/session/ses%2F1/permission`);
  });

  it.each([
    { data: 'no-array' },
    { noData: [] },
    { data: [{ id: 'not-per', sessionID: 'ses_1', action: 'a', resources: [] }] },
    { data: [{ id: 'per_1', sessionID: 'not-ses', action: 'a', resources: [] }] },
    { data: [{ id: 'per_1', sessionID: 'ses_1', action: 'a', resources: 'not-array' }] },
    { data: [{ id: 'per_1', sessionID: 'ses_1', action: 'a', resources: [], source: { type: 'dialog' } }] },
    { data: [{ id: 'per_1', sessionID: 'ses_1', action: 'a', resources: [], metadata: 'not-object' }] },
  ])('fails closed on a malformed list response %j', async body => {
    const fetchImpl = recordingFetch([], () => jsonResponse(body));
    await expect(listSessionPermissions({ baseUrl: BASE, fetchImpl, sessionId: 'ses_1' })).rejects.toMatchObject({
      failure: 'invalid-response',
    });
  });

  it('reports the server status when the session is unknown', async () => {
    const fetchImpl = recordingFetch([], () => jsonResponse({ message: 'not found' }, 404));
    const error = await listSessionPermissions({ baseUrl: BASE, fetchImpl, sessionId: 'ses_1' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ failure: 'http', status: 404 });
  });

  it('refuses a non-local service before any request', async () => {
    let asked = false;
    const fetchImpl = (async () => {
      asked = true;
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;
    await expect(
      listSessionPermissions({ baseUrl: 'https://example.com', fetchImpl, sessionId: 'ses_1' }),
    ).rejects.toBeInstanceOf(Error);
    expect(asked).toBe(false);
  });
});

describe('replySessionPermission', () => {
  it('posts each decision as the exact payload and accepts the 204', async () => {
    for (const decision of PERMISSION_REPLIES) {
      const log: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl = recordingFetch(log, () => new Response(null, { status: 204 }));
      await expect(
        replySessionPermission({ baseUrl: BASE, fetchImpl, sessionId: 'ses_1', requestId: 'per_1', decision }),
      ).resolves.toBeUndefined();
      expect(log[0].url).toBe(`${BASE}/api/session/ses_1/permission/per_1/reply`);
      expect(log[0].init?.method).toBe('POST');
      expect(JSON.parse(String(log[0].init?.body))).toEqual({ decision });
    }
  });

  it('sends the optional message only when one is given', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => new Response(null, { status: 204 }));
    await replySessionPermission({
      baseUrl: BASE,
      fetchImpl,
      sessionId: 'ses_1',
      requestId: 'per_1',
      decision: 'reject',
      message: 'not now',
    });
    expect(JSON.parse(String(log[0].init?.body))).toEqual({ decision: 'reject', message: 'not now' });
    await replySessionPermission({
      baseUrl: BASE,
      fetchImpl,
      sessionId: 'ses_1',
      requestId: 'per_1',
      decision: 'always',
      message: '',
    });
    expect(JSON.parse(String(log[1].init?.body))).toEqual({ decision: 'always' });
  });

  it('url-encodes the session and request ids in the path', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => new Response(null, { status: 204 }));
    await replySessionPermission({
      baseUrl: BASE,
      fetchImpl,
      sessionId: 'ses/1',
      requestId: 'per/1',
      decision: 'once',
    });
    expect(log[0].url).toBe(`${BASE}/api/session/ses%2F1/permission/per%2F1/reply`);
  });

  it.each(['Always', 'never', '', undefined, null, 1])('refuses the decision %j before requesting', async decision => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => new Response(null, { status: 204 }));
    const error = await replySessionPermission({
      baseUrl: BASE,
      fetchImpl,
      sessionId: 'ses_1',
      requestId: 'per_1',
      decision: decision as never,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ failure: 'invalid-reply' });
    expect(log).toHaveLength(0);
  });

  it('fails closed when the server answers something other than 204', async () => {
    const fetchImpl = recordingFetch([], () => jsonResponse({ ok: true }, 200));
    const error = await replySessionPermission({
      baseUrl: BASE,
      fetchImpl,
      sessionId: 'ses_1',
      requestId: 'per_1',
      decision: 'once',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ failure: 'invalid-response', status: 200 });
  });

  it('reports the server status when the request is unknown', async () => {
    const fetchImpl = recordingFetch([], () => jsonResponse({ message: 'not found' }, 404));
    const error = await replySessionPermission({
      baseUrl: BASE,
      fetchImpl,
      sessionId: 'ses_1',
      requestId: 'per_1',
      decision: 'always',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ failure: 'http', status: 404 });
  });

  it('refuses a non-local service before any request', async () => {
    let asked = false;
    const fetchImpl = (async () => {
      asked = true;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await expect(
      replySessionPermission({
        baseUrl: 'https://example.com',
        fetchImpl,
        sessionId: 'ses_1',
        requestId: 'per_1',
        decision: 'once',
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(asked).toBe(false);
  });
});
