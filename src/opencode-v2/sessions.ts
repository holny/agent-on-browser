import { z } from 'zod';
import { parseLocalServiceUrl, serviceHttpUrl } from './url-policy';
import { serviceRequest, parseResponseBody, TransportError, type HttpOptions } from './http';

const AbsoluteDirectorySchema = z
  .string()
  .refine(directory => /^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(directory) && !directory.includes('\0'));
const LocationSchema = z.object({ directory: AbsoluteDirectorySchema });
const CreatedSessionSchema = z.object({ data: z.object({ id: z.string().min(1) }) });
const PromptAdmittedSchema = z.object({ data: z.unknown() });
const InterruptedSchema = z.object({ interrupted: z.boolean() });

export async function resolveLocation(options: HttpOptions & { directory: string }): Promise<string> {
  if (!AbsoluteDirectorySchema.safeParse(options.directory).success)
    throw new TransportError('invalid-directory', 'an explicit absolute directory is required');
  const base = parseLocalServiceUrl(options.baseUrl);
  const url = serviceHttpUrl(base, 'api/location');
  url.searchParams.set('location[directory]', options.directory);
  const response = await serviceRequest(options, url, { method: 'GET' });
  return (await parseResponseBody(response, LocationSchema, 'location')).directory;
}

/** One OpenCode session for one run; its id is the only surface later calls need. */
export async function createSession(
  options: HttpOptions & { directory: string; title?: string; providerID?: string; modelID?: string },
): Promise<string> {
  if (!AbsoluteDirectorySchema.safeParse(options.directory).success)
    throw new TransportError('invalid-directory', 'an explicit absolute directory is required');
  const base = parseLocalServiceUrl(options.baseUrl);
  const model =
    options.providerID && options.modelID ? { id: options.modelID, providerID: options.providerID } : undefined;
  const response = await serviceRequest(options, serviceHttpUrl(base, 'api/session'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      location: { directory: options.directory },
      ...(model ? { model } : {}),
      ...(options.title ? { title: options.title } : {}),
    }),
  });
  const parsed = await parseResponseBody(response, CreatedSessionSchema, 'created session');
  return parsed.data.id;
}

/** Durably admits one user message; the answer arrives later on the event stream. */
export async function promptSession(options: HttpOptions & { sessionId: string; text: string }): Promise<void> {
  const base = parseLocalServiceUrl(options.baseUrl);
  const path = `api/session/${encodeURIComponent(options.sessionId)}/prompt`;
  const response = await serviceRequest(options, serviceHttpUrl(base, path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: options.text }),
  });
  await parseResponseBody(response, PromptAdmittedSchema, 'prompt admission');
}

/** Interrupts the session's active execution; true when one was running. */
export async function interruptSession(options: HttpOptions & { sessionId: string }): Promise<boolean> {
  const base = parseLocalServiceUrl(options.baseUrl);
  const path = `api/session/${encodeURIComponent(options.sessionId)}/interrupt`;
  const response = await serviceRequest(options, serviceHttpUrl(base, path), { method: 'POST' });
  const parsed = await parseResponseBody(response, InterruptedSchema, 'interrupt answer');
  return parsed.interrupted;
}

const ModelListSchema = z.object({
  location: z.unknown().optional(),
  data: z.array(z.object({ providerID: z.string(), modelID: z.string(), name: z.string() })),
});

/** The service's chat models, as providerID + modelID pairs. */
export async function listModels(
  options: HttpOptions,
): Promise<Array<{ providerID: string; modelID: string; name: string }>> {
  const base = parseLocalServiceUrl(options.baseUrl);
  const response = await serviceRequest(options, serviceHttpUrl(base, 'api/model'), { method: 'GET' });
  const parsed = await parseResponseBody(response, ModelListSchema, 'model list');
  return parsed.data;
}

const SwitchedSchema = z.object({}).passthrough();

/** Switches the model used by the session's subsequent turns. */
export async function switchModel(
  options: HttpOptions & { sessionId: string; providerID: string; modelID: string },
): Promise<void> {
  const base = parseLocalServiceUrl(options.baseUrl);
  const path = `api/session/${encodeURIComponent(options.sessionId)}/model`;
  const response = await serviceRequest(options, serviceHttpUrl(base, path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: { id: options.modelID, providerID: options.providerID } }),
  });
  await parseResponseBody(response, SwitchedSchema, 'model switch');
}
