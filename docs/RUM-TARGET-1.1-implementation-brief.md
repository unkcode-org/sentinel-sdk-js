# RUM-TARGET-1.1 — disabled-control interaction audit

Status: **audit and real-browser reproduction complete; implementation held at the interaction-contract gate**  
Audit: 2026-09-29, `main` at `cd41642`, SDK `0.4.0`.

## Findings

The SDK registers one capture-phase `document` listener for native `click` in `src/rum/runtime.ts`. Each received click calls `targetFor(event.target)` and `positionFor(event)`, emits `click`, adds the resolved DOM element and position to a bounded rage history, and, only if `deadEligible`, starts a dead-click timer. Three nearby clicks on the same element within one second yield `rage_click`. The dead timer can emit `dead_click` after 700 ms without an observed response. There is no pointer or mouse down/up listener in the SDK. `event.target` is the target of the click received by the document listener; `targetFor()` walks up to eight ancestors and returns the resolved interactive element. `rage_click` reuses the current click's normalized semantic target; grouping uses DOM element identity, not target text.

The new Playwright fixture uses `page.mouse.click()` three times on each of four buttons and logs trusted events at document capture, where Sentinel listens. Results were identical in Chromium, Firefox, and WebKit:

| Fixture | Raw events per press at document capture | RUM events after three presses |
| --- | --- | --- |
| Enabled, direct text | `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click` | 3 `click`, 1 `rage_click`, 3 `dead_click` |
| Enabled, span text | Same | 3 `click`, 1 `rage_click`, 3 `dead_click` |
| Native disabled, direct text | `pointerdown`, `pointerup` | None |
| Native disabled, span text | `pointerdown`, `pointerup` | None |

The enabled events include `tag: button`, `role: button`, and `text: Confirmar compra`. The disabled controls produced no `click`, so current Sentinel had no `event.target` to resolve and no rage history entry. A `rage_click` for repeated native-disabled presses cannot be produced through this SDK's current trusted browser-event path. The production tag/role-only payload therefore needs additional evidence: the exact originating event and target, the actual SDK build, DOM state at event time, and computed visibility. It cannot be attributed to `disabled` alone in current `main`.

`targetFor()` constructs `tag`/`role` before the human-readable guard. That guard excludes a private marker on the event target or bounded ancestor, sensitive input/select/textarea or contenteditable ancestry, hidden/inert/`aria-hidden` ancestry, ineligible controls, and invisible controls. The text resolver also rejects hidden/private/editable children, unsupported/deeper markup, ambiguity, or budget/grammar overflow. Thus a tag/role-only target is possible when one of these conditions holds. Native `disabled` is **not** among them. The only explicit disabled check is in `deadEligible`: a disabled button cannot become a dead-click candidate. `inert` is excluded because the existing TARGET-1 policy treats hidden/inert regions as ineligible human-readable sources; that rule is distinct from native `disabled`.

TARGET-1 allows short visible text from eligible small buttons and does not exclude native-disabled buttons. Its existing limits remain eight ancestors, twelve direct children, twenty inspected nodes across one formatting-child level, 160 source characters, and 80 UTF-8 output bytes. The current resolver already accepts a direct span. No descendant-traversal or target-text privacy amendment is needed to resolve text **if an eligible event reaches `targetFor()`**.

## Interaction-contract decision required

Detecting native-disabled attempts requires observing another raw browser event. The observed common signals are trusted `pointerdown` and `pointerup`; native `click` is absent. A completed down/up pair on the same visible native-disabled control would give stronger evidence of an attempted interaction than down alone. The SDK must not synthesize a click or count every pointerdown as one.

Counting such attempts in `rage_click` would change its approved meaning from a cluster of browser clicks to a cluster that can include disabled-control pointer attempts. Existing TARGET-1 approval covers target text, not this event-source/meaning change. Before implementation, a human must approve the exact interaction semantics: qualifying pointer pair, target continuity, timing/distance, duplicate prevention if a click is also delivered, cancel/drag behavior, privacy exclusions, and whether the wire event remains `rage_click` or a separately contracted event. Preserve current click and dead-click behavior until that decision. No Ingest, Storage, Query, or frontend change has been made.

## Design-only semantic state

An optional bounded `target.disabled: true` would materially help distinguish attempted interaction with a disabled control from an unresponsive enabled one once an event exists. It cannot solve the missing event by itself. Native `disabled` is a browser-enforced state; `aria-disabled="true"` is an author-declared semantic state and does not suppress native clicks, so they should be evaluated separately before being combined in one field. Adding either state requires an end-to-end target contract, validation, storage, query, and frontend decision. No state field is implemented here.

## Repository gate

This repository has no `AGENTS.md` or `.harness` directory; `npm run verify` is its defined verification command. The original architecture/TDD gate and TARGET-1 target-text amendment are approved. This newly proposed disabled-attempt behavior crosses an interaction-contract gate. Do not deploy.
