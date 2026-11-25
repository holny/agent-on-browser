import { describe, expect, it } from 'vitest';
import {
  isLocalServiceUrl,
  LocalServiceUrlError,
  parseLocalServiceUrl,
  serviceHttpUrl,
  serviceWebSocketUrl,
} from '../url-policy';

describe('the localhost-only URL policy', () => {
  it('accepts only http and https on localhost, 127.0.0.1 and [::1]', () => {
    for (const candidate of [
      'http://localhost:49374',
      'http://127.0.0.1:49374',
      'http://[::1]:49374',
      'http://[0:0:0:0:0:0:0:1]:49374',
      'https://localhost',
      'https://127.0.0.1:8443',
      'http://LOCALHOST:49374',
      'http://127.0.0.1:49374/oc',
    ]) {
      expect(parseLocalServiceUrl(candidate).toString(), candidate).toBeTruthy();
      expect(isLocalServiceUrl(candidate)).toBe(true);
    }
  });

  it('rejects everything else, with the reason', () => {
    const cases: Array<[string, LocalServiceUrlError['reason']]> = [
      ['https://opencode.ai', 'host'],
      ['http://0.0.0.0:49374', 'host'],
      ['http://[::ffff:127.0.0.1]:49374', 'host'],
      ['http://127.0.0.1.evil.test:49374', 'host'],
      ['http://localhost.:49374', 'host'],
      ['ws://localhost:49374', 'scheme'],
      ['file://127.0.0.1/x', 'scheme'],
      ['http://user:pass@localhost:49374', 'credentials'],
      ['http://localhost:49374/?auth_token=abc', 'query'],
      ['http://localhost:49374/#frag', 'query'],
      ['not a url', 'unparseable'],
      ['', 'unparseable'],
      ['http://localhost:99999', 'unparseable'],
    ];
    for (const [candidate, reason] of cases) {
      expect(() => parseLocalServiceUrl(candidate), candidate).toThrow(LocalServiceUrlError);
      try {
        parseLocalServiceUrl(candidate);
      } catch (error) {
        expect((error as LocalServiceUrlError).reason, candidate).toBe(reason);
        expect(isLocalServiceUrl(candidate)).toBe(false);
      }
    }
  });

  it('joins API paths under the base, with or without a subpath', () => {
    expect(serviceHttpUrl(parseLocalServiceUrl('http://127.0.0.1:49374'), 'api/info').toString()).toBe(
      'http://127.0.0.1:49374/api/info',
    );
    expect(serviceHttpUrl(parseLocalServiceUrl('http://127.0.0.1:49374'), '/api/info').toString()).toBe(
      'http://127.0.0.1:49374/api/info',
    );
    expect(serviceHttpUrl(parseLocalServiceUrl('https://localhost:8443/oc'), 'api/info').toString()).toBe(
      'https://localhost:8443/oc/api/info',
    );
  });

  it('builds the client MCP socket URL with the v2.3.2 query encoding', () => {
    const base = parseLocalServiceUrl('http://127.0.0.1:49374');
    const url = serviceWebSocketUrl(base, { name: 'nb', ticket: 'T1', directory: '/work dir' });
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/api/experimental/client-mcp');
    expect(url.searchParams.get('name')).toBe('nb');
    expect(url.searchParams.get('ticket')).toBe('T1');
    expect(url.searchParams.get('location[directory]')).toBe('/work dir');
    expect(url.toString()).toBe(
      'ws://127.0.0.1:49374/api/experimental/client-mcp?location%5Bdirectory%5D=%2Fwork+dir&name=nb&ticket=T1',
    );

    const secure = serviceWebSocketUrl(parseLocalServiceUrl('https://127.0.0.1:8443/oc'), { name: 'nb' });
    expect(secure.protocol).toBe('wss:');
    expect(secure.pathname).toBe('/oc/api/experimental/client-mcp');
    expect(secure.searchParams.get('ticket')).toBeNull();
    expect(secure.searchParams.get('location[directory]')).toBeNull();
  });
});
