# Implementation summary

Visible page text is captured by default in layout and visual modes. Default
maskTextSelector is [data-sentinel-mask]; explicit "*" still masks all text.
Private/editable/control surfaces remain excluded. The shared text decision is
applied at rrweb capture and pre-retention admission, including dynamic changes
and additions during scroll. Text is recorded in replay chunks, never console or
diagnostic logs. Existing recordings cannot recover previously removed text.

The instrumented client configuration supplied by the user only enabled legacy
layout. Images/source CSS require replay.visual.enabled plus matching SDK
resourceOrigins and player REPLAY_RESOURCE_ORIGINS, including relevant CDN hosts
and CORS. No resource-origin controls were relaxed.

Verification: 98 unit/contract tests pass; Replay browser suite has 94 passing
cases and the Chromium-only heap case skipped on the other two engines. The initial
suite run had three stale DOM-heavy masking expectations, updated to reflect the
new authorized text default; all three pass on targeted rerun. Typecheck, lint,
source layout, build, package validation and bundle budget pass. Browser/HTTP
tests require execution outside the restricted sandbox for loopback listeners.

The frontend discovered/fixed same-batch subtree admission loss and consumes an
actual SDK fixture proving text, lazy image and scroll playback. SDK packaging
remains version 0.6.0; publishing a new package version and consuming it in the
application are separate release steps, not performed here.
