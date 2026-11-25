# agent

## OVERVIEW

The single agent loop: one loop per conversation, no planner/navigator pair. Reaches Chrome only through the interfaces `src/extension/` passes in (`ports.ts`).

## WHERE TO LOOK

| Task                          | Location                          | Notes                                                                     |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| The loop itself               | `loop.ts`                         | turns of one model call + its tool batch; all browser policy in six hooks  |
| A run's lifecycle             | `run.ts`                          | `runChat` = no tools: one model call, its reply written as a message entry |
| The tool list the model sees  | `tools.ts`                        | the layer's catalogue as-is + the agent's own; one list for every model; `screenshot` vision-only |
| Context management            | `elision.ts` → `compaction.ts`    | elision (step 1, pure) checks before every request; compaction (step 2) replaces the older part; user messages kept in full |
| What the model is sent        | `context.ts`, `header.ts`         | the active branch becomes AI SDK messages; the page header after the last message is never stored, so the cached prefix survives |
| The system prompt             | `prompt.ts`                       | short and stable, so the prompt prefix stays cached - do not grow it casually |
| Run and conversation records  | `records.ts`                      | every write of a run goes through here, in this order                     |
| Restore after worker restart  | `restore.ts`                      | pure: reads the run record and the branch, says what to write              |
| Success claims                | `completion.ts`                   | the agent must not claim success for an outcome it has not seen           |
| Loop guards                    | `guards.ts`                       | nudge = note on the offending tool result; stop = end the run with one salvage call |
| Attachments                    | `attachments.ts`                  | images and text files, stored as blobs with the conversation               |
| Saved files                    | `save-file.ts`                    | the file name must end in an extension that matches the content            |
| Conversation export           | `export.ts`                       | Markdown, built from the stored branch                                     |
| Tests without a browser       | `testing/`                       | `fake-layer.ts`; pair with `@src/llm` `ScriptedModel` for model-free runs  |

## CONVENTIONS

- No `chrome` global here (eslint `no-restricted-globals`); the browser and the person are reached only through `ports.ts`.
- Every model gets the same agent and the same tools - there are no model tiers.

## ANTI-PATTERNS

- Asking for a page `prompt` dialog's answer after the hand-over (`loop.ts`).
- Page content treated as instructions: it stays inside the layer's page-content boundaries.
- A second model call per turn: the loop runs the tools itself.
