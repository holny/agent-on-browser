import { z } from 'zod';
import { parseLocalServiceUrl, serviceHttpUrl } from './url-policy';

export const OPENCODE_USERNAME = 'opencode';
export const CLIENT_MCP_TOKEN_PATH = 'api/experimental/client-mcp/token';
export const TICKET_HEADER = 'x-opencode-ticket';
export const TICKET_HEADER_VALUE = '1';
export const CLIENT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

const DEFAULT_TIMEOUT_MS = 10_000;

export const ServerInfoSchema = z.object({
  version: z.string(),
  pid: z.number().int().nonnegative(),
  hostname: z.string().nullish(),
  urls: z.array(z.string()),
  paths: z.object({ tmp: z.string() }),
  capabilities: z.object({ persistentPty: z.boolean().nullish() }).nullish(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

const ConnectTokenSchema = z.object({
  location: z.object({ directory: z.string() }),
  data: z.object({ ticket: z.string().min(1), expires_in: z.number().int().positive() }),
});
export type ClientTicket = z.infer<typeof ConnectTokenSchema>['data'];

export type TransportFailure =
  | 'invalid-url'
  | 'invalid-name'
  | 'invalid-directory'
  | 'invalid-reply'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid-response';

export class TransportError extends Error {
  readonly failure: TransportFailure;
  readonly status: number | undefined;

  constructor(failure: TransportFailure, message: string, status?: number) {
    super(message);
    this.failure = failure;
    this.status = status;
  }
}

export interface HttpOptions {
  readonly baseUrl: string;
  readonly password?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export function basicAuthorization(password: string): string {
  // btoa 只收 Latin-1；密码来自设置输入，先用 TextEncoder 转字节再编码，非拉丁字符不抛错。
  const bytes = new TextEncoder().encode(`${OPENCODE_USERNAME}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export async function serviceRequest(options: HttpOptions, url: URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (options.password) headers.set('authorization', basicAuthorization(options.password));
  headers.set('accept', 'application/json');
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new TransportError(
        'http',
        `the opencode server answered ${response.status} for ${url.toString()}`,
        response.status,
      );
    return response;
  } catch (error) {
    if (error instanceof TransportError) throw error;
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new TransportError('timeout', `the opencode server did not answer in time: ${url.toString()}`);
    const cause = error instanceof Error ? error.message : String(error);
    throw new TransportError('network', `cannot reach the opencode server (${cause}): ${url.toString()}`);
  }
}

export async function parseResponseBody<T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new TransportError('invalid-response', `the opencode server's ${what} is not JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new TransportError(
      'invalid-response',
      `the opencode server's ${what} does not match v2.3.2: ${parsed.error.message}`,
    );
  return parsed.data;
}

export async function connectService(options: HttpOptions): Promise<ServerInfo> {
  const base = parseLocalServiceUrl(options.baseUrl);
  const response = await serviceRequest(options, serviceHttpUrl(base, 'api/info'), { method: 'GET' });
  return parseResponseBody(response, ServerInfoSchema, 'server info');
}

export async function mintClientTicket(
  options: HttpOptions & { readonly name: string; readonly directory?: string },
): Promise<ClientTicket> {
  if (!CLIENT_NAME_PATTERN.test(options.name))
    throw new TransportError('invalid-name', `the client MCP name must match ${CLIENT_NAME_PATTERN.toString()}`);
  const base = parseLocalServiceUrl(options.baseUrl);
  const url = serviceHttpUrl(base, CLIENT_MCP_TOKEN_PATH);
  if (options.directory !== undefined) url.searchParams.set('location[directory]', options.directory);
  url.searchParams.set('name', options.name);
  const response = await serviceRequest(options, url, {
    method: 'POST',
    headers: { [TICKET_HEADER]: TICKET_HEADER_VALUE },
  });
  const wrapped = await parseResponseBody(response, ConnectTokenSchema, 'client MCP ticket');
  return wrapped.data;
}
