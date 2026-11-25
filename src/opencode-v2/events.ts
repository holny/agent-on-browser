import { basicAuthorization, type HttpOptions } from './http';
import { parseLocalServiceUrl, serviceHttpUrl } from './url-policy';

/** One server-sent event of the OpenCode stream, as far as the engine reads it. */
export interface ServiceEvent {
  type: string;
  sessionID?: string;
  [key: string]: unknown;
}

export interface EventStream {
  /** Stops reading and closes the response body. Idempotent. */
  close(): void;
}

/**
 * The server's event stream (`GET /api/event`) as parsed JSON events. The stream is live-only: events missed while
 * it is down are gone, so the caller resubscribes and resynchronizes from stored state after a drop.
 */
export function subscribeEvents(
  options: HttpOptions & { onEvent: (event: ServiceEvent) => void; signal?: AbortSignal },
): EventStream {
  const base = parseLocalServiceUrl(options.baseUrl);
  const url = serviceHttpUrl(base, 'api/event');
  const headers = new Headers({ accept: 'text/event-stream' });
  if (options.password) headers.set('authorization', basicAuthorization(options.password));
  let closed = false;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const callerSignal = options.signal;
  const onCallerAbort = () => {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const stop = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  };
  void (async () => {
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers,
        signal: controller.signal,
        cache: 'no-store',
      });
      // The caller's signal may have aborted while the fetch was in flight, before a reader existed to cancel.
      if (callerSignal?.aborted || controller.signal.aborted) throw new Error('the event stream was aborted');
      if (!response.ok || !response.body) throw new Error(`the event stream answered ${response.status}`);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let data: string[] = [];
      const dispatch = () => {
        if (!data.length) return;
        const text = data.join('\n');
        data = [];
        let event: unknown;
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        if (!(event && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string')) return;
        // v2.3.2 把载荷包在信封的 data 字段里；这里一次性摊平，消费方只见 { type, ...载荷 }。
        const { data: payload, ...envelope } = event as { type: string; data?: Record<string, unknown> };
        options.onEvent({ ...envelope, ...(payload ?? {}) } as ServiceEvent);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lineEnd = buffer.indexOf('\n');
          if (lineEnd < 0) break;
          const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
          buffer = buffer.slice(lineEnd + 1);
          if (line === '') {
            dispatch();
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5));
          }
        }
      }
      dispatch();
    } catch {
      // A dropped stream ends the subscription; the caller resubscribes.
    } finally {
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if (!closed) {
        closed = true;
        options.onEvent({ type: 'stream.ended' });
      }
    }
  })();
  return { close: stop };
}
