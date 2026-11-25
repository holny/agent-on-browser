# ui

## OVERVIEW

Shared components, theme, the i18n runtime and the panel protocol: what the side panel and options build on, and the boundary they must not cross - panels talk to the worker only through `protocol.ts`.

## WHERE TO LOOK

| Task                          | Location                                             | Notes                                                        |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| A panel ↔ worker message      | `protocol.ts`                                        | one runtime Port per panel document (`PANEL_PORT_NAME`); commands from the panel, events from the worker; panels never read the stores |
| Add or translate a UI string   | `locales/en.json`, `locales/zh_CN.json`, `locales/zh_TW.json` | keys are typed from `en.json` (`MessageKey`); a missing key falls back to English |
| Add a language                | a new `locales/<tag>.json` + one line in `i18n.ts` (`LOADERS`) |                                                              |
| Language picking              | `language.tsx`, `i18n.ts`                             | "auto" follows the browser's language                        |
| Theme, shared components      | `theme.ts`, `components.tsx`, `icons.tsx`, `hooks.ts` |                                                              |
| Shortcuts, mode menu, voice   | `shortcuts.tsx`, `mode-menu.tsx`, `voice.ts`          |                                                              |
| The manifest's permission lists | `manifest-permissions.ts`                          | maintainer-only path (the file guard fails a pull request that changes it) |
| Optional permission requests | `optional-permissions.ts`                        | which ones the user has allowed; one request for all four, only from a user's click |
| Website links                | `links.ts`                                            | the tag names only the place in the extension, no identifier   |
| What's-new and rating cards   | `whats-new.ts`, `auto-notice.tsx`                    |                                                              |

## CONVENTIONS

- Catalogue completeness is unit-tested (`__tests__/catalogues.test.ts`), and so are the manifest permissions (`__tests__/manifest-permissions.test.ts`).
- Panels draw what the worker sends; state stays in the worker.

## ANTI-PATTERNS

- Importing `@src/agent`, `@src/extension` or `@src/background` from panel code - eslint blocks it.
- Editing `manifest-permissions.ts` in a pull request.
