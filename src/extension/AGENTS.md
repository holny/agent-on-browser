# extension

## OVERVIEW

The product's wiring in the service worker: it owns the state, the runs, permissions and the worker's end of the panel protocol. `entrypoints/background.ts` imports `index.ts` for side effects; listener registration stays synchronous at worker start.

## WHERE TO LOOK

| Task                              | Location                            | Notes                                                                   |
| --------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| Runs, panel commands              | `run-manager.ts`                    | `runManager` (the exported singleton): one run per active conversation    |
| Layer prompts → user cards        | `prompt-broker.ts`                  | write cards, `ask_user` and the loop's hand-overs become cards in the panel |
| Permission modes, site rules      | `permissions.ts`                   | the mode belongs to the conversation; site rules are one map in chrome.storage (policy in the root file) |
| The product's controller          | `layer.ts`                          | one controller for agent sessions and the test panel - not `src/background/layer.ts` |
| Panel protocol, worker end       | `panel-port.ts`, `journal.ts`       | only the extension's own panel may connect; every event gets the next sequence number |
| Tab ↔ conversation ownership     | `bindings.ts`                      | TabScope: which conversation owns a tab, and its tab group                |
| Live model resolution            | `models.ts`                        | stored providers and keys → a callable model and its profile             |
| Per-tab side panel, selection    | `panel.ts`, `selection.ts`         | the panel belongs to the tab; "Ask Nanobrowser about this" opens it       |
| The page border                   | `border.ts`                        | the executeScript payload has no imports; a bfcached page must not keep a border |
| Saved files                       | `downloads.ts`                     | the offscreen document makes a blob URL, the worker downloads it         |
| Upgrade from 0.2                  | `upgrade.ts`                       | works with `src/store/legacy.ts`                                         |
| Analytics                         | `analytics.ts`, `analytics-payload.ts` | daily counts, no identifier; never sent in development or autorun builds |
| Notifications                     | `notify.ts`                        | a run needs the user, or finishes, while no panel of its conversation is in view |
| Screenshot thumbnails            | `thumbnail.ts`                     | small JPEGs made in the worker with OffscreenCanvas                      |
| A new install                     | `first-run.ts`                     | one shortcut, `/summarize`, in the browser's language, not pinned        |
| Agent sessions                    | `agent-session.ts`                | the hand-over policy and the agent's own labels                          |

## CONVENTIONS

- The agent gets Chrome only through what this folder passes into `src/agent/ports.ts` - the agent never imports here.
- Worker state is the truth: panels draw what `journal.ts` sends them.

## ANTI-PATTERNS

- Async listener registration at worker start (`index.ts` keeps it synchronous).
- Panels reading stores or deciding anything themselves.
