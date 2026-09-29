# RUM-TARGET-1.1 — TDD and fix plan

Status: **browser reproduction added; implementation awaits human approval of disabled-attempt event semantics**.

1. Keep the real-pointer four-fixture browser test in Chromium, Firefox, and WebKit as the baseline. It records document-capture raw events and emitted RUM types for enabled/disabled direct and span text. Preserve assertions that enabled controls emit ordinary clicks with bounded text and disabled controls currently emit no RUM event.
2. If disabled attempts are approved for capture, first add failing browser tests for three trusted completed pointer pairs on the same native-disabled button within the approved time/distance window. Assert the approved event type and target text under the existing TARGET-1 limits. Test both direct and span text, including pointer landing on the span.
3. Add rejection tests before implementation: one down without up, release outside or on another control, drag/cancel, non-primary mouse button, unrelated pointer, hidden/inert/private control or ancestor, nested private descendant, sensitive/form/editable content, oversized or unsafe text, and over-budget DOM. Verify no private string appears anywhere in the serialized request.
4. Add duplicate-prevention tests for enabled controls that deliver both pointer pairs and native clicks. Preserve their current `click`, `rage_click`, and `dead_click` counts and grouping identity. Keep disabled attempts out of dead-click classification unless separately approved.
5. Implement only the approved event-source path. Reuse `targetFor()` and its existing text budgets without widening descendant inspection, changing label precedence, or reading unrestricted `textContent`/`innerText`. Keep pointer state bounded and clean listeners/state on shutdown.
6. Run the focused three-browser test, the full `npm run verify`, and `git diff --check`. Review emitted payloads for privacy and contract compatibility. Do not deploy.

The optional `target.disabled` state remains design-only and requires a separate end-to-end contract amendment before any implementation.
