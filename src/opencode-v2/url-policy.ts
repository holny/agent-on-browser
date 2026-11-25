export const LOCAL_HOSTNAMES: ReadonlyArray<string> = ['localhost', '127.0.0.1', '[::1]'];

export type LocalServiceUrlReason = 'unparseable' | 'scheme' | 'host' | 'credentials' | 'query';

export class LocalServiceUrlError extends Error {
  readonly reason: LocalServiceUrlReason;

  constructor(reason: LocalServiceUrlReason, candidate: string) {
    super(`Refusing opencode service URL (${reason}): ${candidate}`);
    this.reason = reason;
  }
}

export function parseLocalServiceUrl(candidate: string): URL {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new LocalServiceUrlError('unparseable', candidate);
  }
  if (url.username !== '' || url.password !== '') throw new LocalServiceUrlError('credentials', candidate);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new LocalServiceUrlError('scheme', candidate);
  if (!LOCAL_HOSTNAMES.includes(url.hostname)) throw new LocalServiceUrlError('host', candidate);
  if (url.search !== '' || url.hash !== '') throw new LocalServiceUrlError('query', candidate);
  return url;
}

export function isLocalServiceUrl(candidate: string): boolean {
  try {
    parseLocalServiceUrl(candidate);
    return true;
  } catch {
    return false;
  }
}

export function serviceHttpUrl(base: URL, path: string): URL {
  const url = new URL(base.toString());
  const prefix = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = prefix + path.replace(/^\/+/, '');
  return url;
}

export function serviceWebSocketUrl(
  base: URL,
  params: { readonly name: string; readonly ticket?: string; readonly directory?: string },
): URL {
  const url = new URL(base.toString());
  const prefix = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = `${prefix}api/experimental/client-mcp`;
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  if (params.directory !== undefined) url.searchParams.set('location[directory]', params.directory);
  url.searchParams.set('name', params.name);
  if (params.ticket !== undefined) url.searchParams.set('ticket', params.ticket);
  return url;
}
