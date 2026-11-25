import { z } from 'zod';
import { parseLocalServiceUrl, serviceHttpUrl } from './url-policy';
import { serviceRequest, parseResponseBody, TransportError, type HttpOptions } from './http';

export const PERMISSION_REPLIES = ['once', 'always', 'reject'] as const;
export type PermissionReply = (typeof PERMISSION_REPLIES)[number];

const PermissionReplySchema = z.enum(PERMISSION_REPLIES);

const PermissionSourceSchema = z.object({
  type: z.literal('tool'),
  messageID: z.string(),
  id: z.string(),
});

export const PermissionRequestSchema = z.object({
  id: z.string().regex(/^per/),
  sessionID: z.string().regex(/^ses/),
  action: z.string(),
  resources: z.array(z.string()),
  save: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  source: PermissionSourceSchema.optional(),
  message: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

const SessionPermissionListSchema = z.object({ data: z.array(PermissionRequestSchema) });

export async function listSessionPermissions(
  options: HttpOptions & { sessionId: string },
): Promise<PermissionRequest[]> {
  const base = parseLocalServiceUrl(options.baseUrl);
  const path = `api/session/${encodeURIComponent(options.sessionId)}/permission`;
  const response = await serviceRequest(options, serviceHttpUrl(base, path), { method: 'GET' });
  const parsed = await parseResponseBody(response, SessionPermissionListSchema, 'session permission list');
  return parsed.data;
}

export async function replySessionPermission(
  options: HttpOptions & {
    sessionId: string;
    requestId: string;
    decision: PermissionReply;
    message?: string;
  },
): Promise<void> {
  if (!PermissionReplySchema.safeParse(options.decision).success)
    throw new TransportError('invalid-reply', 'the permission reply decision must be once, always or reject');
  const base = parseLocalServiceUrl(options.baseUrl);
  const path = `api/session/${encodeURIComponent(options.sessionId)}/permission/${encodeURIComponent(
    options.requestId,
  )}/reply`;
  const response = await serviceRequest(options, serviceHttpUrl(base, path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      decision: options.decision,
      ...(options.message ? { message: options.message } : {}),
    }),
  });
  if (response.status !== 204)
    throw new TransportError(
      'invalid-response',
      `the opencode server answered ${response.status} instead of 204 for the permission reply`,
      response.status,
    );
}
