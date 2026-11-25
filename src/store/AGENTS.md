# store

## OVERVIEW

Settings, keys and the IndexedDB stores - the data contract for the whole extension. Two kinds of storage: `chrome.storage` values (`storage.ts` `createStorage`), which any page reads directly (panels import `settings.ts`, `shortcuts.ts`, `legacy.ts`), and the IndexedDB conversation stores (`db.ts`), which the worker owns and the panels see only through `src/ui/protocol.ts`.

## WHERE TO LOOK

| Task                        | Location                            | Notes                                                            |
| --------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Schema change               | `db.ts`                             | `DB_NAME`, `DB_VERSION`, `db`, `closeDb`; a version bump needs a migration path |
| Conversations               | `conversations.ts`                  | branches, runs, message entries - worker-side                    |
| Settings and provider keys  | `settings.ts`                       | `chrome.storage`; API keys are never exported, logged or sent anywhere but their provider |
| Shortcuts                   | `shortcuts.ts`                      | `chrome.storage`, read by the panel directly                      |
| Analytics counters, rating  | `analytics.ts`, `rating.ts`         |                                                                   |
| The what's-new card         | `whats-new.ts`                      |                                                                   |
| Attachments                 | `attachments.ts`                    | blobs stored with the conversation                               |
| Old-version data            | `legacy.ts`                         | what Nanobrowser 0.2 left in `chrome.storage.local`; moved on first start by `src/extension/upgrade.ts` |
| Storage helper              | `storage.ts`                        | `createStorage`: a value in `chrome.storage` with a cache and listeners, live across pages |
| Record types                | `types.ts`                          | the vocabulary other modules import: `Conversation`, `RunStatus`, `Usage`, … |
| Facade                      | `index.ts`                          | the usual import; a few deep imports exist (`@src/store/settings`, `/legacy`) |

## CONVENTIONS

- Unit tests run on `fake-indexeddb` (a dev dependency, `__tests__/`).
- Store shapes are shared vocabulary: changing one is a cross-module change (worker, panels, tests).
- Scenario sets write conversation entries directly (`@src/store/conversations` from `src/background/scenarios/`).
- Old conversations stay in `chrome.storage.local` until the user exports or deletes them in Settings → Data (`legacy.ts`).
