# core

## OVERVIEW

The layer's logic: controller, sessions, refs, frames, perception, interaction, tools. The root file's 11 invariants are enforced here; the table below says where each one lives.

## WHERE TO LOOK

| Task                                 | Location                                                     | Notes                                                                        |
| ------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Add a tool the agent calls           | `tools/` (one file per verb: `act`, `fill`, `navigate`, …)   | register in `tools/index.ts`; dispatched, reacted, reached reported separately |
| Ref or stale-node failure            | `refs.ts`                                                    | refs are epoch-prefix + shared counter, handed out once; stale refs fail closed with `StaleReason` |
| Actionability, retries               | `interaction/actionability.ts`, `interaction/preflight.ts`   | retries happen BEFORE dispatch; after dispatch no second attempt               |
| Sensitive-action confirmation        | `interaction/classify.ts`, `interaction/gate.ts`              | submit / pay / delete confirm before dispatch; categories `submit\|pay\|delete\|grant\|upload\|script` |
| Stuck key or button after a run      | `interaction/withheld.ts`                                    | synthetic releases for endings that must not take effect                     |
| Page observation                     | `perception/capture.ts`, `perception/observe.ts`, `perception/ax.ts` | read-only; partial capture and truncation stated in the result         |
| Masking (passwords, cards, codes)    | `perception/masking.ts`, `redact.ts`, `refs.ts` (`shownName`)  | masked values never printed back                                            |
| Text sent toward the model           | `text.ts`                                                    | `untrusted` / `quote` / `defuse`; boundary-marker copies never reach the model verbatim |
| Ambiguous navigation                 | `navigation-guard.ts`                                         | fails closed                                                                  |
| Tab locks                            | `lock.ts`                                                    | released, not just forgotten (`tools/navigate.ts`)                          |
| Session / controller lifecycle       | `controller.ts`, `ports.ts`                                  | core imports no Puppeteer, no chrome.\*; `host/` implements `ports.ts`     |
| Probe calls from core                 | `probe-client.ts`                                            | the typed bridge to `probe/source.ts`                                        |

## CONVENTIONS

- Core code reaches the browser only through the interfaces in `ports.ts`.
- Every command, wait and list has a budget; a bound belongs near its use, not in a distant config.
- Pure logic gets unit tests over recorded CDP payloads (`__tests__/payloads/`).

## ANTI-PATTERNS

- Dispatch then retry: once an input event is sent, the layer never sends another on its own.
- Substituting a different node or mechanism silently: the choice is made by rule before dispatch and named in the receipt.
- Anything that changes the page during observation.
