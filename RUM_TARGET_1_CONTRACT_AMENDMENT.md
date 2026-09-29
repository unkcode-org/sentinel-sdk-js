# RUM-TARGET-1 — interaction target contract amendment

Status: **Approved; additive implementation prepared locally in rollout order; production rollout pending**  
Audit date: 2026-09-28

RUM-TARGET-1.1 adds an approved interaction-attempt interpretation of the
existing `rage_click` event. It does not expand this document's human-readable
target eligibility, descendant traversal, or byte budgets. See
`docs/RUM-TARGET-1.1-implementation-brief.md` for the SDK-only scope; proposed
`target.disabled` and `target.aria_disabled` fields remain a separate future
end-to-end contract slice.

## Contract decision

The current RUM wire contract cannot carry a human-readable control label or
visible text. `sentinel-ingest`'s `RUMTarget` is a closed object with only
`tag`, `role`, and `test_id`; its strict decoder rejects unknown target keys.
The private storage protobuf, ClickHouse row, Query response, and dashboard
model likewise have only those three fields. Putting text into `test_id`,
`role`, another event field, or `data` would violate their semantics or closed
shapes. The current identifier grammar also excludes spaces and most natural
language. An additive contract amendment is necessary.

The browser SDK has no `.harness` or `AGENTS.md`; its `package.json` defines
`npm run verify`. The cross-repository implementations have their own harnesses
and must enter those harnesses separately after this contract/privacy decision.
The global RUM architecture requires a RUM-specific DOM privacy review before
interaction capture changes. The decision below adopts automatic capture and
explicit exclusion. The SDK build must not be released to production until
Storage, Ingest, Query, and Frontend have deployed the additive contract.

## Approved additive contract

Add two **optional** properties to the existing interaction `target` object:

| JSON / Query property | Storage `Target` protobuf | Meaning | Bound |
| --- | --- | --- | --- |
| `label` | `string label = 4;` | Explicit approved accessible label from the resolved control's own `aria-label` | 80 UTF-8 bytes |
| `text` | `string text = 5;` | Approved short visible text of the resolved control, only when `label` is absent | 80 UTF-8 bytes |

The protobuf field numbers 4 and 5 are unused in the inspected `Target`
message. Existing `tag`, `role`, and `test_id` remain optional and unchanged,
including their 128-byte safe-identifier limit. Keep the current requirement
that at least one of those **existing** three identifiers is present; new
strings alone do not make a target valid. `label` and `text` are omitted when
empty or unsafe. No new event type or top-level event key is proposed.

The wire spelling and 80-byte limit above are approved. Validation must
normalize whitespace to one ASCII space, trim, reject controls,
reject URL-like or query/fragment-bearing strings and known sensitive patterns,
and omit strings over 80 UTF-8 bytes rather than truncate into a misleading
label. Reject malformed values at ingest and storage. A pattern filter alone
cannot establish that DOM text is free of personal data.

**Approved privacy decision:** eligible small interactive controls may
automatically contribute approved bounded `label` or `text` without manual
annotation. `label` takes precedence over `text`. An element with the
`data-sentinel-private` attribute contributes no human-readable target
metadata, and the exclusion applies to its descendants. During the same
bounded ancestor walk used to resolve the control, inspect at most eight
elements total, beginning at the event target and including the resolved
control, for this marker. If found, omit both
fields. Still emit an otherwise valid interaction event with safe existing
`tag`, `role`, and `test_id` metadata. Sensitive controls are excluded from
human-readable extraction even without a marker. The marker's value is never
read or serialized. Developer-provided `test_id` continues under the existing
safe-identifier policy.

## SDK implementation

1. Resolve one interactive element for all three click-like events using at
   most eight examined elements, including the event target; check those elements
   for `data-sentinel-private` in the same bounded walk. Prefer `button`, `a`,
   `input`, `select`, `textarea`, or an element with a supported `role` or
   `data-testid`. Stop at the first meaningful candidate. A nested SVG/text
   node should resolve to its button. Fall back to the original element when
   no candidate exists. Do not build CSS paths or run document queries.
2. Preserve the existing shared normalized `Target` object. Use that same
   object for `click`, rage history/emission, and dead-click candidates.
   Keep rage identity stable if an optional label/text changes: grouping
   should use the resolved element's bounded in-memory identity rather than
   volatile text.
3. Keep the existing `test_id` omit-on-invalid/oversize behavior (128 bytes,
   existing ASCII grammar). Native buttons contribute the stable `button`
   role when no explicit safe role is present.
4. Automatically read only the resolved control's own safe `aria-label`; do not compute
   an accessibility name, follow `aria-labelledby`, read associated form
   labels, or inspect arbitrary attributes. If no accepted explicit label is
   available, read only a strictly bounded amount of immediate visible text
   from an eligible small control. Do not call unbounded `textContent` or
   `innerText` on a subtree. Bound inspected child nodes and source characters,
   and omit on overflow or ambiguity. Normalize whitespace and accept at most
   80 UTF-8 bytes; omit oversized output.
5. Exclude `input`, `textarea`, `select`, password controls,
   `[contenteditable]`, form-field labels, hidden/inert/`aria-hidden` text,
   and controls inside sensitive regions from human-readable extraction.
   A private marker on the control or a bounded ancestor also suppresses
   `label` and `text`.
   Never read values, `innerHTML`, `outerHTML`, arbitrary dataset values,
   event objects, or URLs as target identity.
6. Keep per-click work O(8 ancestors + a fixed small number of direct child
   nodes + at most a fixed source-character budget). No document-wide query,
   new observer, recursion, selector generation, or DOM serialization.

Tests must prove ordinary button text and own `aria-label` are captured
automatically; nested SVG resolves to its button; `data-sentinel-private` on
the control or a parent suppresses `label` and `text` while the event is still
emitted; input, password, textarea, select, and contenteditable values or
contents are never captured; arbitrary container text is not captured; a
bounded extractor cannot walk or serialize an arbitrary subtree; and click,
rage, and dead events share the privacy behavior. Also verify whitespace
normalization, Unicode byte bounds, oversize omission, stable rage grouping,
and old-client/historical-event compatibility.

The implemented SDK extractor examines at most eight elements on the event
target's ancestor chain, then at most twelve direct child nodes and twenty
nodes total across one formatting-child level. It processes at most 160 source
characters, accepts at most 80 UTF-8 output bytes, and omits over-limit or
ambiguous text. It never recurses through arbitrary descendants. A small
letter/space/hyphen vocabulary is used for automatic human text, which favors
omission over capturing dynamic values with digits or URL-like punctuation.
Rage grouping uses the resolved DOM element's in-memory identity; no selector,
DOM path, random value, or additional wire field is emitted.

## Affected boundaries and safe rollout

1. **`sentinel-rum-storage`**: add protobuf `Target` fields 4/5; regenerate Go
   bindings; extend domain model, gRPC write/read mapping and validation; add
   nullable `target_label` and `target_text` columns by additive ClickHouse
   migration; extend insert/search scanning. Existing rows read as null.
   Deploy storage before Ingest or Query starts sending/expecting these fields.
2. **`sentinel-ingest`**: update its copied storage protobuf binding and gRPC
   mapper, domain target, strict decoder, limits, tests, and public OpenAPI
   `RUMTarget` schema. Keep schema version 1 if the additive optional-field
   decision is approved; old v1 events remain valid. Deploy before the SDK
   emits the new keys. The server must continue to reject unknown keys.
3. **`sentinel-query`**: update its copied storage protobuf binding and read
   validation/mapping, domain and JSON DTO, tests, and Query OpenAPI target
   shape. Optional fields must be absent on historical events. Deploy before
   the dashboard expects the properties.
4. **`sentinel-rum-frontend`**: regenerate its Query contract types, extend
   response validation, and render `label` then `text` above semantic metadata
   in Session Detail. Fall back to `tag`/`role`/`test_id` when absent. Render
   as escaped text. Show rage count/duration and existing position/viewport
   when present; do not require any new field.
5. **`sentinel-sdk-js`**: implement the one bounded extractor and tests,
   then run `npm run verify`. Release/deploy SDK last so existing ingest does
   not reject whole batches for unknown target properties.

No Core, OTLP, replay, or unrelated component contract needs a change.

## Audit baseline and resulting payload

Today a click on an SVG inside `<button>Finalizar compra</button>` can resolve
to the button because `targetFor()` uses `closest()`, but only `{ "tag":
"button" }` is sent if no explicit role or test ID is present. The browser's
`closest()` call has no explicit ancestor bound, and other supported semantic
elements such as arbitrary `[role]` and `[data-testid]` are not selected.
`click`, `rage_click`, and `dead_click` previously received one normalized
target; rage compared `JSON.stringify(target)` and dead-click candidates
retained it. The target was created in `src/rum/runtime.ts`. Ingest's strict
decoder and OpenAPI schema confirmed that adding `label` or `text` before the
server rollout would reject the entire batch.

With the approved code, a click on an unmarked checkout button produces a
target like:

```json
{"tag":"button","role":"button","test_id":"cart-checkout","text":"Finalizar compra"}
```

An accepted own `aria-label` produces `label` instead of `text`. A private
control or a control inside a marked bounded ancestor still emits the event
with `tag`/`role`/`test_id` while omitting both human-readable fields. SDK
emission of the new fields is the final **production** rollout step, after
Storage, Ingest, Query, and Frontend have deployed.

Evidence inspected: SDK `src/rum/runtime.ts`, `RUM_IMPLEMENTATION_BRIEF.md`,
`TDD_PLAN.md`, browser RUM tests, and `package.json`; Ingest
`docs/specs.md`, ADR-004, `backend/docs/openapi.yaml`, and strict decoder;
Storage `storage.proto`, validation, ClickHouse schema and read/write paths;
Query read mapper and OpenAPI; frontend Query validator and EventTimeline;
global RUM architecture and ADR-005/006.
