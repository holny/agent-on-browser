import { describe, expect, it } from 'vitest';
import { createSession, interruptSession, promptSession, resolveLocation } from '../sessions';
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

describe('resolveLocation', () => {
  it('resolves the explicit directory using the location query', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => jsonResponse({ directory: '/canonical/project' }));
    await expect(resolveLocation({ baseUrl: BASE, fetchImpl, directory: '/work dir/project' })).resolves.toBe(
      '/canonical/project',
    );
    expect(new URL(log[0].url).pathname).toBe('/api/location');
    expect(new URL(log[0].url).searchParams.get('location[directory]')).toBe('/work dir/project');
    expect(log[0].init?.method).toBe('GET');
  });

  it.each(['', 'relative/path', '.', 'C:relative', undefined])(
    'rejects invalid directory %s before requesting',
    async directory => {
      const log: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl = recordingFetch(log, () => jsonResponse({ directory: '/server/default' }));
      await expect(
        resolveLocation({ baseUrl: BASE, fetchImpl, directory: directory as string }),
      ).rejects.toBeInstanceOf(Error);
      expect(log).toHaveLength(0);
    },
  );

  it.each([{}, { directory: '' }, { directory: 'relative' }, { directory: 3 }])(
    'rejects malformed or non-absolute location response %j',
    async body => {
      const fetchImpl = recordingFetch([], () => jsonResponse(body));
      await expect(resolveLocation({ baseUrl: BASE, fetchImpl, directory: '/project' })).rejects.toMatchObject({
        failure: 'invalid-response',
      });
    },
  );
});

describe('createSession', () => {
  it('posts the resolved location and returns the session id', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => jsonResponse({ data: { id: 'ses_1' } }));
    const id = await createSession({ baseUrl: BASE, fetchImpl, directory: '/canonical/project' });
    expect(id).toBe('ses_1');
    expect(log[0].url).toBe(`${BASE}/api/session`);
    expect(log[0].init?.method).toBe('POST');
    expect(JSON.parse(String(log[0].init?.body))).toEqual({ location: { directory: '/canonical/project' } });
  });

  it('sends the title when one is given', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => jsonResponse({ data: { id: 'ses_2' } }));
    await createSession({ baseUrl: BASE, fetchImpl, directory: '/project', title: 'My tab work' });
    expect(JSON.parse(String(log[0].init?.body))).toEqual({
      location: { directory: '/project' },
      title: 'My tab work',
    });
  });

  it('passes the server-resolved directory to session creation', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, url =>
      new URL(url).pathname === '/api/location'
        ? jsonResponse({ directory: '/canonical/project' })
        : jsonResponse({ data: { id: 'ses_3' } }),
    );
    const directory = await resolveLocation({ baseUrl: BASE, fetchImpl, directory: '/alias/project' });
    await createSession({ baseUrl: BASE, fetchImpl, directory });
    expect(JSON.parse(String(log[1].init?.body))).toEqual({ location: { directory: '/canonical/project' } });
  });

  it('fails closed on a response without an id', async () => {
    const fetchImpl = recordingFetch([], () => jsonResponse({ data: {} }));
    await expect(createSession({ baseUrl: BASE, fetchImpl, directory: '/project' })).rejects.toMatchObject({
      failure: 'invalid-response',
    });
  });

  it('refuses a non-local service before any request', async () => {
    let asked = false;
    const fetchImpl = (async () => {
      asked = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await expect(
      createSession({ baseUrl: 'https://example.com', fetchImpl, directory: '/project' }),
    ).rejects.toBeInstanceOf(Error);
    expect(asked).toBe(false);
  });

  it.each(['', 'relative', undefined])('rejects invalid directory %s before requesting', async directory => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => jsonResponse({ data: { id: 'ses_1' } }));
    await expect(createSession({ baseUrl: BASE, fetchImpl, directory: directory as string })).rejects.toBeInstanceOf(
      Error,
    );
    expect(log).toHaveLength(0);
  });
});

describe('promptSession', () => {
  it('posts the text to the session prompt path', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => jsonResponse({ data: { id: 'inbox_1' } }));
    await promptSession({ baseUrl: BASE, fetchImpl, sessionId: 'ses/1', text: '观察这个页面' });
    expect(log[0].url).toBe(`${BASE}/api/session/ses%2F1/prompt`);
    expect(JSON.parse(String(log[0].init?.body))).toEqual({ text: '观察这个页面' });
  });

  it('fails closed when the server rejects the prompt', async () => {
    const fetchImpl = recordingFetch([], () => jsonResponse({ message: 'conflict' }, 409));
    await expect(promptSession({ baseUrl: BASE, fetchImpl, sessionId: 'ses_1', text: 'x' })).rejects.toBeInstanceOf(
      TransportError,
    );
  });
});

describe('interruptSession', () => {
  it('reports whether an execution was interrupted', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(log, () => jsonResponse({ interrupted: true }));
    await expect(interruptSession({ baseUrl: BASE, fetchImpl, sessionId: 'ses_1' })).resolves.toBe(true);
    expect(log[0].url).toBe(`${BASE}/api/session/ses_1/interrupt`);
    expect(log[0].init?.method).toBe('POST');
  });
});
