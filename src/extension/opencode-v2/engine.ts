// One run on the OpenCode V2 engine: the run's user message goes to a fresh OpenCode session, the session's
// events come back as the panel's stream, and OpenCode drives the browser only through this extension's tools,
// gated to the session id and run through the conversation's own layer session.
import { TOOL_SPECS, argsJsonSchema, type Session } from '@src/browser-control';
import type { LoopEnd } from '@src/agent/loop';
import { RunWriter } from '@src/agent/records';
import { assistantDisplay } from '@src/agent/display';
import { newId } from '@src/store/conversations';
import { ZERO_USAGE } from '@src/store/types';
import type { PanelEventBody, ToolRow } from '@src/ui/protocol';
import type { PageBorder } from '../border';
import { layerPort } from '../agent-session';
import {
  connectClientMcp,
  connectService,
  createSession,
  interruptSession,
  listModels,
  listSessionPermissions,
  replySessionPermission,
  PermissionRequestSchema,
  promptSession,
  resolveLocation,
  SessionAllowlist,
  subscribeEvents,
  type ClientMcpTool,
  type EventStream,
  type ServiceEvent,
} from '@src/opencode-v2';

/** Layer tools an OpenCode session never gets: page script, devtools, and the two whose wiring is still ahead. */
const NOT_EXPOSED = new Set(['eval', 'devtools', 'upload', 'ask_user']);

const MAX_RESULT_CHARS = 30_000;
/** The browser tools must attach before the first prompt; past this the run fails rather than answering tool-less. */
const MCP_READY_TIMEOUT_MS = 10_000;
/** A dropped event stream is live-only: resubscribe with backoff, and fail the run when it keeps failing. */
const STREAM_DROP_BASE_MS = 500;
const STREAM_DROP_MAX_MS = 10_000;
const STREAM_DROP_LIMIT = 10;
/** After Stop, the interrupted event has this long to arrive before the run ends without it. */
const INTERRUPT_GRACE_MS = 15_000;
const PROMPT_SETTLE_GRACE_MS = 5_000;

function exposedSchema(name: string): Record<string, unknown> | undefined {
  const spec = TOOL_SPECS.find(s => s.name === name);
  if (!spec) return undefined;
  const schema = { ...(argsJsonSchema(spec) as Record<string, unknown>) };
  delete schema.$schema;
  if (schema.properties && typeof schema.properties === 'object') {
    const props = { ...(schema.properties as Record<string, unknown>) };
    delete props.observe;
    schema.properties = props;
    if (Array.isArray(schema.required)) schema.required = (schema.required as string[]).filter(r => r !== 'observe');
  }
  return schema;
}

export function exposedTools(call: (tool: string, args: Record<string, unknown>) => Promise<unknown>): ClientMcpTool[] {
  return TOOL_SPECS.filter(spec => spec.available && !NOT_EXPOSED.has(spec.name)).map(spec => ({
    name: spec.name,
    description: spec.description,
    inputSchema: exposedSchema(spec.name),
    handler: async (args: Record<string, unknown>) => {
      const result = await call(spec.name, args);
      const text = JSON.stringify(result ?? null);
      const truncated = text.length > MAX_RESULT_CHARS;
      return {
        content: [{ type: 'text' as const, text: truncated ? `${text.slice(0, MAX_RESULT_CHARS)}…[truncated]` : text }],
      };
    },
  }));
}

export interface V2ServiceConfig {
  readonly url: string;
  readonly password: string;
  readonly directory?: string;
  /** The model the run uses; absent keeps the service's default for the session. */
  readonly model?: { readonly providerID: string; readonly modelID: string };
}

export interface V2TurnOptions {
  readonly conversationId: string;
  readonly runId: string;
  readonly text: string;
  readonly turnCap: number;
  readonly layer: Session;
  readonly border: Pick<PageBorder, 'around'> | undefined;
  readonly signal: AbortSignal;
  readonly emit: (event: PanelEventBody) => void;
  readonly requestPermission: (data: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  readonly service: V2ServiceConfig;
}

interface TurnState {
  turns: number;
  done: { end: LoopEnd } | null;
  streamId: string;
  buffered: string;
  /** 在跑的工具调用：id → 面板工具行（input.started 建，success/failed 收尾）。 */
  toolRows: Map<string, ToolRow>;
  /** 工具的原始入参（input.ended 带回）。 */
  toolInputs: Map<string, { name: string; argsText: string }>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 引擎默认选型的偏好：本机服务的默认模型常落在不可达的网关/路由上，有可达的 zhipu flash 就用它。 */
const PREFERRED_PROVIDER = /zhipu/i;
const PREFERRED_MODEL = /glm-5\.3-flash/i;

async function pickModel(http: {
  baseUrl: string;
  password?: string;
}): Promise<{ providerID: string; modelID: string } | null> {
  const models = await listModels(http).catch(() => []);
  return (
    models.find(m => PREFERRED_PROVIDER.test(m.providerID) && PREFERRED_MODEL.test(m.modelID)) ??
    models.find(m => PREFERRED_MODEL.test(m.modelID)) ??
    models[0] ??
    null
  );
}

/**
 * Runs one turn on OpenCode V2. The three execution events end the run; everything between is stream for the panel
 * and entries for the branch, written as it arrives so a restart leaves an honest record. The browser tools attach
 * before the first prompt; the event stream is live-only, so drops are resubscribed with backoff and a run whose
 * stream keeps failing ends failed rather than hanging.
 */
export async function runV2Turn(options: V2TurnOptions): Promise<LoopEnd> {
  if (!options.service.url) throw new Error('The OpenCode V2 service address is not set.');
  if (!options.text.trim()) throw new Error('The message has no text to send to the OpenCode engine.');
  const http = {
    baseUrl: options.service.url,
    ...(options.service.password ? { password: options.service.password } : {}),
  };
  await connectService(http);
  const directorySetting = options.service.directory?.trim();
  if (!directorySetting) throw new Error('The OpenCode agent has no project directory set.');
  const directory = await resolveLocation({ ...http, directory: directorySetting });
  const model = options.service.model ?? (await pickModel(http));
  const ocSession = await createSession({
    ...http,
    directory,
    ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
  });
  const allow = new SessionAllowlist();
  allow.add(ocSession);
  const port = layerPort(options.layer, options.border);
  const tools = exposedTools((tool, args) => port.call(tool, args, options.signal));
  // 连接名带 runId：并发的两个 run 不会互相顶掉对方的工具（服务端同名连接是栈，新连接遮蔽旧连接）。
  const readied = { value: false };
  let readyResolve: () => void = () => undefined;
  const ready = new Promise<void>(resolve => {
    readyResolve = () => {
      readied.value = true;
      resolve();
    };
  });
  // 挂载超时的真因：拨号失败时 client-mcp 用一次普通 HTTP 请求问出服务的拒绝状态（403 多为 origin 白名单）。
  let dialFailure: string | undefined;
  const mcp = connectClientMcp({
    ...http,
    directory,
    name: `nanobrowser-${options.runId}`,
    tools,
    sessions: allow,
    onReady: () => readyResolve(),
    onError: () => undefined,
    onDialFailure: detail => {
      dialFailure = detail;
    },
  });
  const writer = new RunWriter(options.conversationId, options.runId);
  const state: TurnState = {
    turns: 0,
    done: null,
    streamId: newId(),
    buffered: '',
    toolRows: new Map<string, ToolRow>(),
    toolInputs: new Map<string, { name: string; argsText: string }>(),
  };
  const inflight = new Set<Promise<unknown>>();
  const permissions = new Map<string, AbortController>();
  let acceptingPermissions = true;
  let failPermission = (_error: unknown) => {};
  const onPermission = (raw: unknown) => {
    if (!acceptingPermissions || options.signal.aborted) return;
    const parsed = PermissionRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.sessionID !== ocSession || permissions.has(parsed.data.id)) return;
    const request = parsed.data;
    const controller = new AbortController();
    permissions.set(request.id, controller);
    const run = async () => {
      const answer = await options.requestPermission(
        { action: request.action, resources: request.resources, canRemember: false },
        controller.signal,
      );
      if (controller.signal.aborted || options.signal.aborted) return;
      const decision = answer === 'approve' ? 'once' : 'reject';
      await replySessionPermission({ ...http, sessionId: ocSession, requestId: request.id, decision });
    };
    const pending = run()
      .catch(error => failPermission(error))
      .finally(() => permissions.delete(request.id));
    inflight.add(pending);
    void pending.then(() => inflight.delete(pending));
  };
  options.emit({ type: 'agent_start', runId: options.runId });
  // MV3 的 service worker 会因空闲被杀；每 20 秒一个 MCP ping 让 WS 上有活动，计时器随之重置（Chrome 116+），
  // 引擎的等待链才活得过 LLM 的静默思考期。
  const keepalive = setInterval(() => mcp.ping(), 20_000);
  try {
    // 等浏览器工具真正挂上（MCP initialize → tools/list 完成）再发 prompt，否则模型第一步就没有工具。
    await Promise.race([
      ready,
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, MCP_READY_TIMEOUT_MS);
        void ready.then(() => clearTimeout(timer));
        options.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
      }),
    ]);
    if (!readied.value && !options.signal.aborted)
      throw new Error(
        dialFailure
          ? `The OpenCode browser tools did not attach in time. The last connection attempt: ${dialFailure}. This extension's origin is chrome-extension://${chrome.runtime.id}.`
          : 'The OpenCode browser tools did not attach in time.',
      );

    await new Promise<void>((resolve, reject) => {
      const streams: EventStream[] = [];
      let closed = false;
      let interruptSent = false;
      let drops = 0;
      let promptError: unknown = null;
      const promptSettled = promptSession({ ...http, sessionId: ocSession, text: options.text }).catch(error => {
        promptError = error;
      });
      const finish = (error?: unknown) => {
        if (closed) return;
        closed = true;
        acceptingPermissions = false;
        options.signal.removeEventListener('abort', onAbort);
        for (const stream of streams) stream.close();
        for (const controller of permissions.values()) controller.abort();
        // 在途的落库先落完，再放行 agent_end 与回合结果。
        void Promise.allSettled([...inflight]).then(() => (error ? reject(error) : resolve()));
      };
      failPermission = error => {
        void interruptSession({ ...http, sessionId: ocSession }).catch(() => undefined);
        finish(error);
      };
      const onAbort = () => {
        void (async () => {
          // 等 prompt 落定再打断，避免一个还在路上的 prompt 变成服务端的孤儿执行。
          await Promise.race([promptSettled, sleep(PROMPT_SETTLE_GRACE_MS)]);
          if (closed || interruptSent) return;
          interruptSent = true;
          await interruptSession({ ...http, sessionId: ocSession }).catch(() => undefined);
          // interrupted 事件负责收尾；不来的话到期兜底结束。
          setTimeout(() => finish(), INTERRUPT_GRACE_MS);
        })();
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      const pump = (delay = 0) => {
        if (closed) return;
        if (state.done) return finish();
        if (delay) {
          setTimeout(() => pump(), delay);
          return;
        }
        const inner = subscribeEvents({
          ...http,
          signal: options.signal,
          onEvent: event => {
            if (closed) return;
            if (event.type !== 'stream.ended') drops = 0;
            if (event.type === 'permission.asked') onPermission(event);
            if (
              event.type === 'permission.replied' &&
              event.sessionID === ocSession &&
              typeof event.requestID === 'string'
            ) {
              permissions.get(event.requestID)?.abort();
            }
            if (event.type === 'server.connected') {
              void listSessionPermissions({ ...http, sessionId: ocSession })
                .then(requests => requests.forEach(onPermission))
                .catch(error => {
                  if (!closed && !options.signal.aborted) failPermission(error);
                });
            }
            handleEvent(event, ocSession, options, state, writer, inflight);
            if (state.done) return finish();
            if (event.type === 'stream.ended') {
              drops += 1;
              if (drops > STREAM_DROP_LIMIT)
                return finish(new Error('The OpenCode event stream kept dropping; the run cannot continue.'));
              pump(Math.min(STREAM_DROP_BASE_MS * 2 ** (drops - 1), STREAM_DROP_MAX_MS));
            }
          },
        });
        streams.push(inner);
      };
      pump();
      void promptSettled.then(() => {
        if (promptError && !closed && !state.done) finish(promptError);
      });
    });
    if (!state.done) {
      await interruptSession({ ...http, sessionId: ocSession }).catch(() => undefined);
      state.done = { end: { status: 'stopped', usage: ZERO_USAGE, turns: state.turns } };
    }
    return state.done.end;
  } finally {
    acceptingPermissions = false;
    for (const controller of permissions.values()) controller.abort();
    clearInterval(keepalive);
    options.emit({ type: 'agent_end', runId: options.runId });
    mcp.close();
  }
}

function handleEvent(
  event: ServiceEvent,
  ocSession: string,
  options: V2TurnOptions,
  state: TurnState,
  writer: RunWriter,
  inflight: Set<Promise<unknown>>,
): void {
  if (event.sessionID !== ocSession) return;
  const emit = options.emit;
  switch (event.type) {
    case 'session.step.started': {
      state.turns += 1;
      emit({ type: 'turn_start', turn: state.turns });
      emit({ type: 'message_start', id: state.streamId });
      // 回合上限：超过就打断并按 capped 收尾，不再继续烧模型。
      if (options.turnCap > 0 && state.turns > options.turnCap) {
        state.done = { end: { status: 'capped', usage: ZERO_USAGE, turns: state.turns } };
      }
      return;
    }
    case 'session.text.delta': {
      state.buffered += typeof event.delta === 'string' ? event.delta : '';
      emit({ type: 'message_update', id: state.streamId, text: state.buffered });
      return;
    }
    case 'session.text.ended': {
      state.buffered = '';
      const text = typeof event.text === 'string' ? event.text : '';
      if (!text) return;
      const write = writer
        .message({ role: 'assistant', parts: [{ type: 'text', text }] })
        .then(entry => emit({ type: 'message_end', entry: assistantDisplay(entry) }));
      inflight.add(write);
      void write.finally(() => inflight.delete(write));
      return;
    }
    case 'session.step.ended':
    case 'session.step.failed': {
      emit({ type: 'turn_end', turn: state.turns });
      return;
    }
    case 'session.execution.succeeded': {
      state.done = { end: { status: 'done', outcome: 'success', usage: ZERO_USAGE, turns: state.turns } };
      return;
    }
    case 'session.execution.failed': {
      const reason = errorReason(event.error);
      state.done = {
        end: { status: 'failed', outcome: 'failed', reason, cause: 'provider', usage: ZERO_USAGE, turns: state.turns },
      };
      return;
    }
    case 'session.execution.interrupted': {
      state.done = { end: { status: 'stopped', usage: ZERO_USAGE, turns: state.turns } };
      return;
    }
    case 'session.tool.input.started': {
      const id = String(event.id ?? '');
      const name = String(event.name ?? '');
      state.toolRows.set(id, {
        toolCallId: id,
        tool: name,
        args: {},
        status: 'running',
      });
      state.toolInputs.set(id, { name, argsText: '' });
      emit({
        type: 'tool_execution_start',
        messageId: String(event.assistantMessageID ?? ''),
        row: state.toolRows.get(id)!,
      });
      return;
    }
    case 'session.tool.input.delta': {
      const pending = state.toolInputs.get(String(event.id ?? ''));
      if (pending) pending.argsText += typeof event.delta === 'string' ? event.delta : '';
      return;
    }
    case 'session.tool.input.ended': {
      const pending = state.toolInputs.get(String(event.id ?? ''));
      if (pending) pending.argsText = typeof event.text === 'string' ? event.text : pending.argsText;
      return;
    }
    case 'session.tool.called': {
      const pending = state.toolRows.get(String(event.id ?? ''));
      const inputRecord = state.toolInputs.get(String(event.id ?? ''));
      if (!pending || !inputRecord) return;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(inputRecord.argsText || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      pending.args = args;
      void writer.intent(pending.toolCallId, pending.tool, args);
      return;
    }
    case 'session.tool.success': {
      const pending = state.toolRows.get(String(event.id ?? ''));
      if (!pending) return;
      pending.status = 'done';
      const content = (event.content ?? []) as Array<{ type?: string; text?: string }>;
      const text = content.map(c => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
      void writer.toolResult(pending.toolCallId, pending.tool, text || '(no output)', false).then(entry => {
        pending.status = 'done';
        emit({
          type: 'tool_execution_end',
          messageId: String(event.assistantMessageID ?? ''),
          row: { ...pending, status: 'done' },
        });
        void entry;
      });
      emit({
        type: 'tool_execution_end',
        messageId: String(event.assistantMessageID ?? ''),
        row: { ...pending, status: 'done' },
      });
      return;
    }
    case 'session.tool.failed': {
      const pending = state.toolRows.get(String(event.id ?? ''));
      if (!pending) return;
      pending.status = 'failed';
      const err = (event.error ?? {}) as { message?: string };
      const text = err.message ? `The tool failed: ${err.message}` : 'The tool failed.';
      void writer.toolResult(pending.toolCallId, pending.tool, text, true).then(() =>
        emit({
          type: 'tool_execution_end',
          messageId: String(event.assistantMessageID ?? ''),
          row: { ...pending, status: 'failed' },
        }),
      );
      emit({
        type: 'tool_execution_end',
        messageId: String(event.assistantMessageID ?? ''),
        row: { ...pending, status: 'failed' },
      });
      return;
    }
  }
}

function errorReason(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string')
    return `The OpenCode run failed: ${(error as { message: string }).message}`;
  return 'The OpenCode run failed.';
}
