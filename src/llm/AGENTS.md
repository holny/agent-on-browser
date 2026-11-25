# llm

## OVERVIEW

Model providers, profiles, streaming, overflow detection and transcription. Knows nothing about browsers - enforced by eslint: no browser/agent/extension/store/ui imports, no `chrome` global.

## WHERE TO LOOK

| Task                        | Location          | Notes                                                                                |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| Add a provider              | `providers.ts`    | factories for OpenAI, Anthropic, Google and Bedrock (`aws4fetch` signs Bedrock's model list); a model handle is only a model, its call settings and provider options |
| Model catalogue rows        | `catalogue.ts`    | `findRow`, `MAX_/MIN_CONTEXT_WINDOW`, `REASONING_EFFORTS`, `NOT_CHAT`, `sendRule`    |
| Model profiles              | `profiles.ts`     | each fact comes from the first source that states it, overrides on the model entry first |
| A streaming call            | `stream.ts`       | one streaming call per turn, no automatic tool execution - the loop runs the tools; retries live here |
| Context-overflow detection  | `overflow.ts`     | patterns follow pi-ai's `isContextOverflow`                                          |
| Local-server concurrency    | `limiter.ts`      | queues requests; many local servers take one at a time                                |
| Test models, model lists    | `connection.ts`   | called from the options page directly                                                 |
| Voice input                | `transcribe.ts`   | OpenAI's or Gemini's transcription model, called with the user's key                  |
| Model-free tests            | `scripted.ts`     | `ScriptedModel` for agent and extension tests                                         |
| Errors                      | `errors.ts`       |                                                                                       |

## CONVENTIONS

- A "model" here is never an agent: no tool wiring in this folder, the loop owns tool calls.
- Everything is exported through the facade `index.ts`.

## ANTI-PATTERNS

- Browser or Chrome types and globals anywhere in this folder.
- Automatic tool execution in a provider call.
