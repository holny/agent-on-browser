# browser-control

## OVERVIEW

The deterministic browser-control layer: observes a page, acts on it, reports what happened. No LLM anywhere inside. The root AGENTS.md's fixed constraints and 11 invariants hold for every file here; read them before touching perception or interaction code.

## STRUCTURE

- `index.ts` - the only entry other code may import; every layer symbol used outside comes through here
- `protocol/` - the wire contract: `results.ts` (result types), `schemas.ts` (zod), `errors.ts` (error codes), `catalogue.ts` (the tool catalogue); imports nothing from core or host
- `core/` - the logic: controller, sessions, refs, frames, perception, interaction, tools (see `core/AGENTS.md`)
- `host/` - the ports implemented: `chrome-host.ts` (chrome.tabs + the epoch store), `connection.ts` (chrome.debugger attach), `cdp-session.ts` (raw CDP), `puppeteer.ts` + `frame-topology.ts` (the frame manager), `page-port.ts`
- `probe/` - the only in-page code: `source.ts` is the probe source, exported as the `PROBE_SOURCE` string constant

## WHERE TO LOOK

| Task                       | Location                                     | Notes                                                                  |
| -------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| Add or change an agent tool | `core/tools/<verb>.ts` + `protocol/catalogue.ts` | keep name, schema, result and receipt in step                      |
| Export a symbol to outside  | `index.ts`                                   | eslint blocks deep imports from other modules                          |
| New error code             | `protocol/errors.ts`                         | results carry typed errors; nothing throws across the boundary         |
| Attach / detach lifecycle  | `host/connection.ts`                         | chrome.debugger only                                                    |
| Frame or session lookup    | `host/puppeteer.ts`, `host/frame-topology.ts` | Puppeteer is the frame manager; no parallel registry                   |
| Raw CDP command            | `host/cdp-session.ts`                       | `sendRaw`, `PAGE_SESSION_ALIAS`                                         |
| URL allow / block policy   | `core/url-policy.ts`                         | `siteKey`, `isBlockedSite`                                              |
| What runs in the page      | `probe/source.ts`                           | a string constant: no imports, no bundler assumptions                   |

## CONVENTIONS

- Nothing in this folder imports from outside it. Only `host/` touches Chrome, and only through the interfaces in `core/ports.ts`.
- A new inbound dependency is added to `index.ts`, never a deep path.

## ANTI-PATTERNS

- Finding elements through Puppeteer: no selectors, no `ElementHandle`, no selector-based `evaluate`. Element commands are raw CDP sent to the frame's session.
- A second frame or session registry built from CDP events.
- CDP over WebSocket, even for tests. `chrome.debugger` is the only route.
- Any model or LLM call inside the layer.
