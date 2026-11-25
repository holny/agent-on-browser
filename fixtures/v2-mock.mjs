// An in-memory mock of the OpenCode V2 service for the browser checks. It binds an ephemeral port on 127.0.0.1
// inside the fixture server process and speaks the subset of the V2 API the extension's client uses: server info,
// location, model list, sessions, prompt, event stream (SSE), permission asks and replies, and the client MCP
// WebSocket where the extension attaches its browser tools. State lives in memory only; the main fixture server
// drives it through the /__v2mock endpoints and reads its logs through /__v2mock/state.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const ABSOLUTE_DIRECTORY = /^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;
const CLIENT_NAME = /^[a-zA-Z0-9_-]+$/;
const DECISIONS = new Set(['once', 'always', 'reject']);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SSE_KEEPALIVE_MS = 10_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const log = {
  asks: [],
  sessions: [],
  prompts: [],
  asked: [],
  replies: [],
  pending: [],
  toolLists: [],
  tickets: [],
  mcpConnections: [],
  finished: [],
};
const aborted = new Set();
const subscribers = new Set();
let counter = 0;
let sockets = 0;
let baseUrl = '';

export function v2MockReset() {
  for (const key of Object.keys(log)) log[key] = [];
  aborted.clear();
  counter = 0;
}

export function v2MockScript(asks) {
  log.asks = (Array.isArray(asks) ? asks : [])
    .filter(a => a && typeof a.action === 'string')
    .map((a, i) => ({
      action: a.action,
      resources: Array.isArray(a.resources) ? a.resources.map(String) : [],
      token: typeof a.token === 'string' && a.token ? a.token : `MOCK-V2-ASK-${i + 1}`,
      message: 'The mock service asks on its scripted step.',
    }));
}

export function v2MockSnapshot() {
  return {
    url: baseUrl,
    asks: [...log.asks],
    sessions: [...log.sessions],
    prompts: [...log.prompts],
    asked: log.asked.map(a => ({ ...a })),
    replies: [...log.replies],
    pending: [...log.pending],
    toolLists: [...log.toolLists],
    tickets: [...log.tickets],
    mcpConnections: [...log.mcpConnections],
    finished: [...log.finished],
    subscribers: subscribers.size,
    sockets,
  };
}

export function v2MockUrl() {
  return baseUrl;
}

function emit(type, payload) {
  const frame = `data: ${JSON.stringify({ type, data: payload })}\n\n`;
  for (const res of [...subscribers]) {
    try {
      res.write(frame);
    } catch {
      subscribers.delete(res);
    }
  }
}

function subscribe(res) {
  subscribers.add(res);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  res.write(': connected\n\n');
  const timer = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(timer);
    }
  }, SSE_KEEPALIVE_MS);
  res.on('close', () => {
    clearInterval(timer);
    subscribers.delete(res);
  });
}

function finishRun(sessionId, text) {
  if (aborted.has(sessionId)) return;
  log.finished.push({ sessionID: sessionId, text, at: new Date().toISOString() });
  emit('session.text.ended', { sessionID: sessionId, text });
  emit('session.execution.succeeded', { sessionID: sessionId });
}

async function runScript(sessionId) {
  const deadline = Date.now() + 5_000;
  while (subscribers.size === 0 && Date.now() < deadline) await sleep(25);
  await sleep(200);
  if (aborted.has(sessionId)) return;
  emit('session.step.started', { sessionID: sessionId });
  const ask = log.asks.shift();
  if (!ask) return finishRun(sessionId, 'MOCK-V2-NO-ASK-SCRIPTED');
  const id = `per_m${++counter}`;
  const pending = {
    id,
    sessionID: sessionId,
    action: ask.action,
    resources: ask.resources,
    ...(ask.message ? { message: ask.message } : {}),
  };
  log.pending.push(pending);
  log.asked.push({ ...pending, token: ask.token, at: new Date().toISOString() });
  emit('permission.asked', {
    id,
    sessionID: sessionId,
    action: ask.action,
    resources: ask.resources,
    ...(ask.message ? { message: ask.message } : {}),
  });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'accept, authorization, content-type, x-opencode-ticket',
    'access-control-max-age': '600',
  });
  res.end(JSON.stringify(body));
}

function noContent(res) {
  res.writeHead(204, {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'accept, authorization, content-type, x-opencode-ticket',
    'access-control-max-age': '600',
  });
  res.end();
}

async function handle(req, res, path, url) {
  if (req.method === 'OPTIONS') return noContent(res);
  if (path === '/api/info' && req.method === 'GET') {
    return json(res, 200, {
      version: '2.3.2-mock',
      pid: process.pid,
      hostname: 'v2-mock.local',
      urls: [baseUrl],
      paths: { tmp: '/tmp' },
      capabilities: { persistentPty: false },
    });
  }
  if (path === '/api/location' && req.method === 'GET') {
    const directory = url.searchParams.get('location[directory]') ?? '';
    if (!ABSOLUTE_DIRECTORY.test(directory))
      return json(res, 400, { error: { message: 'an absolute directory is required' } });
    return json(res, 200, { directory });
  }
  if (path === '/api/model' && req.method === 'GET') {
    return json(res, 200, { data: [{ providerID: 'mock', modelID: 'mock-model', name: 'Mock Model' }] });
  }
  if (path === '/api/session' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const directory = body?.location?.directory ?? '';
    if (!ABSOLUTE_DIRECTORY.test(directory))
      return json(res, 400, { error: { message: 'an absolute directory is required' } });
    const id = `ses_m${++counter}`;
    log.sessions.push({
      id,
      directory,
      model: body?.model ?? null,
      title: body?.title ?? null,
      at: new Date().toISOString(),
    });
    return json(res, 200, { location: { directory }, data: { id } });
  }
  const sessionMatch =
    /^\/api\/session\/([^/]+)(?:\/(prompt|interrupt|permission)|\/permission\/([^/]+)\/reply)?$/.exec(path);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2];
    const requestId = sessionMatch[3] !== undefined ? decodeURIComponent(sessionMatch[3]) : undefined;
    if (req.method === 'POST' && action === 'prompt') {
      const body = JSON.parse((await readBody(req)) || '{}');
      log.prompts.push({ sessionId, text: String(body?.text ?? ''), at: new Date().toISOString() });
      void runScript(sessionId);
      return json(res, 200, { data: { id: `msg_m${++counter}` } });
    }
    if (req.method === 'POST' && action === 'interrupt') {
      aborted.add(sessionId);
      log.pending = log.pending.filter(p => p.sessionID !== sessionId);
      return json(res, 200, { interrupted: true });
    }
    if (req.method === 'GET' && action === 'permission') {
      return json(res, 200, { data: log.pending.filter(p => p.sessionID === sessionId) });
    }
    if (req.method === 'POST' && requestId !== undefined) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const decision = body?.decision;
      if (!DECISIONS.has(decision))
        return json(res, 400, { error: { message: 'the decision must be once, always or reject' } });
      const index = log.pending.findIndex(p => p.id === requestId && p.sessionID === sessionId);
      if (index < 0) return json(res, 404, { error: { message: `no pending permission ${requestId}` } });
      const [pending] = log.pending.splice(index, 1);
      log.replies.push({ requestId, sessionID: sessionId, decision, at: new Date().toISOString() });
      noContent(res);
      const ask = log.asked.find(a => a.id === requestId);
      finishRun(sessionId, ask?.token ?? 'MOCK-V2-PERM-DONE');
      return;
    }
  }
  if (path === '/api/event' && req.method === 'GET') return subscribe(res);
  if (path === '/api/experimental/client-mcp/token' && req.method === 'POST') {
    if (req.headers['x-opencode-ticket'] !== '1')
      return json(res, 403, { error: { message: 'a ticket header is required' } });
    const name = url.searchParams.get('name') ?? '';
    if (!CLIENT_NAME.test(name)) return json(res, 400, { error: { message: 'the client name is invalid' } });
    const directory = url.searchParams.get('location[directory]') ?? '';
    const ticket = `t_m${++counter}`;
    log.tickets.push({ ticket, name, directory, at: new Date().toISOString() });
    return json(res, 200, { location: { directory }, data: { ticket, expires_in: 300 } });
  }
  return json(res, 404, { error: { message: `unknown mock endpoint: ${req.method} ${path}` } });
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function parseFrames(buffer, chunk, handlers) {
  let rest = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (rest.length < 2) return rest;
    const fin = (rest[0] & 0x80) !== 0;
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let length = rest[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (rest.length < 4) return rest;
      length = rest.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (rest.length < 10) return rest;
      const big = rest.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return rest;
      length = Number(big);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (rest.length < offset + maskLength + length) return rest;
    let payload = rest.subarray(offset + maskLength, offset + maskLength + length);
    if (masked) {
      const mask = rest.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    rest = rest.subarray(offset + maskLength + length);
    if (opcode === 0x8) {
      handlers.onClose();
      return null;
    }
    if (opcode === 0x9) handlers.onPing(payload);
    else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) handlers.onPayload(fin, payload);
  }
}

function openClientMcp(req, socket) {
  const url = new URL(req.url ?? '/', 'http://mock.local');
  if (url.pathname !== '/api/experimental/client-mcp') return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  sockets += 1;
  log.mcpConnections.push({
    name: url.searchParams.get('name') ?? '',
    ticket: url.searchParams.get('ticket') ?? '',
    directory: url.searchParams.get('location[directory]') ?? '',
    at: new Date().toISOString(),
  });
  let nextId = 0;
  let initId = null;
  let toolsId = null;
  const send = text => {
    if (!socket.destroyed) socket.write(encodeFrame(text));
  };
  const request = (method, params) => {
    const id = `srv_${++nextId}`;
    send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  };
  const fragments = [];
  const onPayload = (fin, payload) => {
    fragments.push(payload);
    if (!fin) return;
    const text = Buffer.concat(fragments).toString('utf8');
    fragments.length = 0;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.method === 'ping' && message.id !== undefined) {
      send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      return;
    }
    if (message.id === undefined || message.result === undefined) return;
    if (initId !== null && message.id === initId) {
      initId = null;
      send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      toolsId = request('tools/list', {});
      return;
    }
    if (toolsId !== null && message.id === toolsId) {
      toolsId = null;
      const tools = Array.isArray(message.result?.tools)
        ? message.result.tools.map(t => t?.name).filter(n => typeof n === 'string')
        : [];
      log.toolLists.push({ tools, at: new Date().toISOString() });
    }
  };
  const onClose = () => {
    try {
      socket.end(Buffer.from([0x88, 0x00]));
    } catch {
      socket.destroy();
    }
  };
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    if (buffer === null) return;
    try {
      buffer = parseFrames(buffer, chunk, {
        onPayload,
        onClose,
        onPing: payload => {
          if (!socket.destroyed) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        },
      });
    } catch {
      socket.destroy();
      return;
    }
    if (buffer === null) buffer = Buffer.alloc(0);
  });
  socket.on('close', () => {
    sockets -= 1;
  });
  socket.on('error', () => socket.destroy());
  initId = request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'opencode-mock', version: '2.3.2' },
  });
}

export async function startV2Mock() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    handle(req, res, url.pathname, url).catch(error => {
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: { message: String(error) } });
    });
  });
  server.on('upgrade', openClientMcp);
  await new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolveServer());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { url: baseUrl, port: server.address().port, server };
}
