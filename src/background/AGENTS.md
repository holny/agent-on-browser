# background

## OVERVIEW

The layer's test extension in the worker: it hosts the layer for the test panel, relays the panel's messages and runs the automated checks. Not the product's wiring - that is `src/extension/`. Two `layer.ts` and two `panel-port.ts` files exist on purpose.

## STRUCTURE

- `index.ts` - side-effect imports + `startAutorun()`
- `checks/` - 56 automated checks, one file each, imported in `checks/index.ts`, run through `checks/registry.ts` (`runCheck`)
- `scenarios/` - scenario sets over `fixtures/pages/` (`set-a` … `set-u` and named sets like `masked-names.ts`), registered in `scenarios/registry.ts`
- `autorun.ts` - unattended runs: a build with `WXT_AUTORUN_URL` set asks the fixture server for a job and posts the reports back; normal builds skip it entirely
- `messages.ts`, `rpc.ts`, `prompts.ts`, `panel-port.ts`, `tabs.ts` - the test panel's plumbing and `UserPrompt`
- `layer.ts`, `spike-session.ts`, `fixtures-config.ts` - the test extension's controller and session

## WHERE TO LOOK

| Task                             | Location                                                   | Notes                                                        |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Add an automated check           | new file in `checks/`, imported in `checks/index.ts`        | the name says what it verifies; reports land in `fixtures/.results/` |
| Add a scenario set                | `scenarios/<set>.ts` + `scenarios/registry.ts`             | fixture pages live under `fixtures/pages/`                   |
| Run checks                        | `pnpm autorun <check>[,<check>...] [--args <json>] [--scale <n>]` | headless Chrome for Testing, `--use-mock-keychain`, no external CDP |
| Manifest permission warnings     | `pnpm autorun permission-warnings`                        | before every release                                         |
| Live-model checks                | `checks/llm-live.ts`, `checks/eval.ts`                      | run by hand, never in CI                                     |
| The test panel's vocabulary      | `messages.ts`, `prompts.ts`                               |                                                              |

## CONVENTIONS

- A check runs in the autorun copy, which asks for the permissions the product does not (tab groups, notifications, downloads); `--product-permissions` builds the strict copy for `without-permissions`.
- The layer keeps its `sensitive` policy here: submit, pay and delete actions, and page script, are confirmed before dispatch.
- Scenario naming follows the sets (`set-a` …); permission behaviour is scripted in `scenarios/set-g-loop.ts` (reading and moving never ask).
