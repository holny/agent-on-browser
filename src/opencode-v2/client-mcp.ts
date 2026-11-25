import { CLIENT_NAME_PATTERN, mintClientTicket, TransportError, type HttpOptions } from './http';
import type { SessionGate } from './session-allowlist';
import { parseLocalServiceUrl, serviceWebSocketUrl } from './url-policy';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const SESSION_ID_META_KEY = 'ai.opencode/sessionID';

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const NORMAL_CLOSE_CODE = 1000;

export type ClientMcpToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

export interface ClientMcpToolResult {
  readonly content: ReadonlyArray<ClientMcpToolContent>;
  readonly isError?: boolean;
}

export interface ClientMcpToolContext {
  readonly sessionID?: string;
}

export interface ClientMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  handler(
    args: Record<string, unknown>,
    context: ClientMcpToolContext,
  ): ClientMcpToolResult | Promise<ClientMcpToolResult>;
}

export interface WebSocketLike {
  readonly readyState: number;
  readonly OPEN: number;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

const defaultSocketFactory: SocketFactory = url => new WebSocket(url);

export interface ClientMcpOptions extends HttpOptions {
  readonly name: string;
  readonly directory?: string;
  readonly tools: ReadonlyArray<ClientMcpTool>;
  readonly sessions: SessionGate;
  readonly socketImpl?: SocketFactory;
  readonly reconnect?: { readonly minMs?: number; readonly maxMs?: number };
  readonly onReady?: () => void;
  readonly onError?: (error: unknown) => void;
  /** Why the latest connection attempt failed, in words a user can act on; the engine names it in an attach timeout. */
  readonly onDialFailure?: (detail: string) => void;
}

export interface ClientMcpConnection {
  close(): void;
  /** An MCP ping over the open socket: traffic that keeps a MV3 service worker alive while a run waits. */
  ping(): void;
}

interface McpParams {
  readonly protocolVersion?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly _meta?: Record<string, unknown> | undefined;
}

interface McpMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: McpParams;
}

type McpReply = { result: unknown } | { error: { code: number; message: string } };

function parseMcpMessage(text: string): McpMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as McpMessage;
}

function readSessionID(params: McpMessage['params']): string | undefined {
  const meta = params?._meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const value = meta[SESSION_ID_META_KEY];
  return typeof value === 'string' ? value : undefined;
}

function isArgsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function connectClientMcp(options: ClientMcpOptions): ClientMcpConnection {
  const base = parseLocalServiceUrl(options.baseUrl);
  if (!CLIENT_NAME_PATTERN.test(options.name))
    throw new TransportError('invalid-name', `the client MCP name must match ${CLIENT_NAME_PATTERN.toString()}`);
  const reconnectMin = options.reconnect?.minMs ?? RECONNECT_MIN_MS;
  const reconnectMax = options.reconnect?.maxMs ?? RECONNECT_MAX_MS;
  const openSocket = options.socketImpl ?? defaultSocketFactory;
  const state: {
    disposed: boolean;
    delay: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    socket: WebSocketLike | undefined;
    outId: number;
  } = { disposed: false, delay: reconnectMin, timer: undefined, socket: undefined, outId: 0 };

  const schedule = () => {
    if (state.disposed) return;
    state.timer = setTimeout(open, state.delay);
    state.delay = Math.min(state.delay * 2, reconnectMax);
  };

  const send = (socket: WebSocketLike, message: object) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  const respond = async (method: string, params: McpMessage['params']): Promise<McpReply> => {
    switch (method) {
      case 'initialize':
        return {
          result: {
            protocolVersion:
              typeof params?.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: options.name, version: '1.0.0' },
          },
        };
      case 'ping':
        return { result: {} };
      case 'tools/list':
        return {
          result: {
            tools: options.tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: { type: 'object', ...tool.inputSchema },
            })),
          },
        };
      case 'tools/call':
        return callTool(params);
    }
    return { error: { code: -32601, message: `Method not found: ${method}` } };
  };

  const callTool = async (params: McpMessage['params']): Promise<McpReply> => {
    const sessionID = readSessionID(params);
    if (!options.sessions.has(sessionID))
      return {
        result: {
          content: [
            {
              type: 'text',
              text:
                sessionID === undefined
                  ? 'refused: the tool call carries no opencode session ID'
                  : `refused: opencode session ${sessionID} is not on the allowlist`,
            },
          ],
          isError: true,
        },
      };
    const tool = options.tools.find(candidate => candidate.name === params?.name);
    if (!tool) return { error: { code: -32602, message: `Unknown tool: ${String(params?.name)}` } };
    const args = isArgsObject(params?.arguments) ? params.arguments : {};
    try {
      const result = await tool.handler(args, { sessionID });
      return { result: { content: [...result.content], isError: result.isError } };
    } catch (error) {
      return {
        result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        },
      };
    }
  };

  const deliver = async (socket: WebSocketLike, text: string) => {
    const message = parseMcpMessage(text);
    if (!message) return;
    if (message.method === 'notifications/initialized') {
      state.delay = reconnectMin;
      options.onReady?.();
    }
    if ((typeof message.id !== 'string' && typeof message.id !== 'number') || typeof message.method !== 'string')
      return;
    const reply = await respond(message.method, message.params);
    send(socket, { jsonrpc: '2.0', id: message.id, ...reply });
  };

  const open = () => {
    if (state.disposed) return;
    void mintClientTicket({
      baseUrl: options.baseUrl,
      password: options.password,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      name: options.name,
      directory: options.directory,
    })
      .then(ticket => {
        if (state.disposed) return;
        const url = serviceWebSocketUrl(base, {
          name: options.name,
          directory: options.directory,
          ticket: ticket.ticket,
        });
        const socket = openSocket(url.toString());
        state.socket = socket;
        // A dial that never opened names its real cause once; a socket that opened and later closed (a server
        // restart) is normal and says nothing.
        let opened = false;
        let reported = false;
        const fail = () => {
          if (opened || reported || state.disposed) return;
          reported = true;
          void probeDial(url).then(detail => options.onDialFailure?.(detail));
        };
        socket.addEventListener('open', () => {
          opened = true;
        });
        socket.addEventListener('message', event => {
          if (state.disposed || typeof event.data !== 'string') return;
          void deliver(socket, event.data);
        });
        // An error without a following close would stall the reconnect; force the schedule.
        socket.addEventListener('error', () => {
          if (state.socket === socket) state.socket = undefined;
          fail();
          try {
            socket.close();
          } catch {
            // already closed
          }
          schedule();
        });
        socket.addEventListener('close', () => {
          if (state.socket === socket) state.socket = undefined;
          fail();
          schedule();
        });
      })
      .catch(error => {
        options.onDialFailure?.(error instanceof Error ? error.message : String(error));
        options.onError?.(error);
        schedule();
      });
  };

  // The browser WebSocket API hides the server's rejection status, so a failed handshake asks the same URL over
  // plain HTTP once: the status names the real cause (a 403 is the origin list or the ticket, a 401 the password).
  const probeDial = async (socketUrl: URL): Promise<string> => {
    const httpUrl = socketUrl.toString().replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    try {
      const response = await (options.fetchImpl ?? fetch)(httpUrl, { headers: { accept: 'application/json' } });
      if (response.status === 403)
        return 'the service answered 403: it rejects this extension origin (add it to the service cors list) or the ticket';
      if (response.status === 401) return 'the service answered 401: authentication failed';
      if (response.status === 404) return 'the service answered 404: this build has no client MCP route';
      return `the service answered ${response.status}`;
    } catch {
      return 'the service is unreachable';
    }
  };

  open();

  return {
    close() {
      state.disposed = true;
      clearTimeout(state.timer);
      state.socket?.close(NORMAL_CLOSE_CODE);
    },
    /** An MCP ping over the open socket: traffic that keeps a MV3 service worker alive while a run waits. */
    ping() {
      if (state.socket && !state.disposed) send(state.socket, { jsonrpc: '2.0', id: ++state.outId, method: 'ping' });
    },
  };
}
