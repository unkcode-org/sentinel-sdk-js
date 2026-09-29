# RUM-TARGET-1.1 implementation brief — design gate

Status: **SDK-only implementation and verification complete; target-state wire fields deferred; no deploy**
Audit: 2026-09-29, `main` at `cd41642`, SDK `0.4.0`. Detailed proposal: `docs/RUM-INTERACTION-ATTEMPTS-design.md`.

## Audited cause and existing boundary

`RumRuntime` receives only document-capture `click` for click/rage/dead detection. `targetFor(event.target)` resolves up to eight ancestors, then the same semantic target is reused. Rage currently clusters three native clicks on the same resolved DOM element within 1,000 ms and normalized radius 0.04; dead-click is a separate 700 ms eligibility/response check.

Real mouse presses in Chromium, Firefox, and WebKit delivered pointer down/up but no click on a native disabled button, with or without a span. Enabled versions delivered click and bounded `text: Confirmar compra`. The disabled control therefore never entered current rage detection. `disabled` itself does not suppress TARGET-1 text; it suppresses dead-click candidacy. Existing one-level text traversal and all privacy/source/output budgets stay unchanged.

## Selected product direction

Retain one `rage_click` event and redefine its meaning as multiple rapid, nearby **interaction attempts** against one logical target. A qualifying completed pointer pair followed by native click contributes once through the existing click path. A qualifying pair without correlated click contributes once without fabricating `click` or `dead_click`. Three settled attempts use the existing rage timing, spatial, identity, sample-cap, and suppression rules. Existing click and dead-click emission remain behaviorally unchanged. No new `frustrated_interaction` or `repeated_interaction` event is proposed.

The existing wire `data.click_count` would count attempts after this semantic amendment; its name is legacy. Old events contain click-derived attempts only. The wire shape can remain compatible, but documentation and UI must say “attempts,” and longitudinal comparisons must account for the SDK rollout boundary. Storage/Query rage event counts and filters remain physical-event aggregations and need no schema change for the attempt-only mechanism.

## Implementation boundaries

**Approved SDK-only implementation:** bounded pointerId down/up pairing; same logical connected target; movement, scroll, cancel, long-press and multi-touch rejection; 32 ms click correlation calibrated in three browsers with mouse and touch; one rage sample per action; no synthetic click; stable element grouping. Known controls reuse TARGET-1 semantic text rules. Generic nested presentation children resolve through at most four nearby elements after an eight-element safety walk; unroled generic targets use only safe tag and own identifiers, with no human-readable text. Private/sensitive/hidden/editable/form regions fail closed for the new pointer path.

**End-to-end Target contract:** To distinguish enabled native button, native disabled button, ARIA-disabled control, and generic element, propose optional boolean `target.disabled` (`true` or `false` for inspected native buttons, absent for inapplicable/historical targets) and separate optional `target.aria_disabled` (only an own exact `"true"` or `"false"` ARIA value). Native disabled and ARIA disabled mean different things. These fields require Storage/Ingest/Query/frontend/schema/migration and SDK work; none is implemented now. Historical rows have unknown/absent state. Deploy Storage first, then Query/Ingest support, then frontend, then SDK emission. Strict Ingest rejects an early unknown target key and can reject the entire batch.

The interaction and privacy rules are approved for this SDK slice. The optional target-state fields are deferred. Do not deploy.

Verification: `npm run verify` passed with 82 Vitest tests and 99 Playwright browser tests across Chromium, Firefox, and WebKit. Typecheck, lint, package validation, and bundle checks passed. The measured core is 213,900 bytes minified and 64,600 bytes gzip against 215,000/65,000 budgets. `git diff --check` is required at handoff.
