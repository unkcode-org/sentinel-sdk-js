# RUM-2B implementation brief

Audit: 2026-09-23. The SDK is on `main` at `ea75992` before this work, with a clean tree. Baseline `npm run verify` passed (64 Vitest tests, 9 Playwright tests, typecheck, lint, package validation, bundle check). This repository has no `AGENTS.md` or `.harness` directory; its `TDD_PLAN.md` gate is marked complete for the earlier OTel implementation. The adjacent `sentinel` and `sentinel-ingest` harnesses are scoped to their own repositories. The ingest RUM-2A source and OpenAPI schema were inspected, including the closed event shapes, validation patterns, and 100-event limit.

1. The browser-only runtime lives in `src/rum/`, separate from `src/telemetry/`; `Sentinel` remains the public facade.
2. `Sentinel.init()` starts RUM after OTel setup when `rum.enabled` is true and a browser exists. `flush()` awaits both pipelines; `shutdown()` removes RUM observations and flushes its queue before OTel shutdown. Repeated equivalent init returns the same instance.
3. Crypto-generated opaque IDs are stored with last activity in `sessionStorage` under one versioned key; inactivity over 30 minutes rotates the ID. Storage exceptions fall back to memory. No user identity is read.
4. Queue cap: 200 events. Batch threshold: 20 events. Flush interval: 5 seconds. Each request has at most 20 events, below ingest's 100-event limit and 1 MiB body limit.
5. Overflow drops the oldest queued event. Transport failures cannot grow the queue beyond the cap.
6. Retry transient failures once after a 1-second delay; permanent 4xx except 429 are dropped. No unlimited retry. Fetch timeout: 5 seconds.
7. Lifecycle flush uses `fetch` with `keepalive: true`, Authorization and JSON content type; Beacon is not used. Delivery on page close is best effort and limited by browser keepalive quotas.
8. Initial `page_view` is captured at startup; one shared history wrapper for `pushState`/`replaceState` and `popstate` observes pathname changes. Same pathname does not emit twice; shutdown restores owned wrappers.
9. Rage: 3 eligible clicks on the same bounded semantic target within 1,000 ms and within 4% of viewport diagonal. A cluster emits once with count 3 and elapsed duration; old clicks expire; history is capped at 16.
10. Dead click: an eligible button interaction is classified only after 700 ms without route change, DOM mutation, focus change, or observed fetch activity. Anchors, fields, forms, disabled controls, and ambiguous targets are excluded. At most 16 candidates are pending; ambiguity yields no event.
11. One temporary `MutationObserver` watches mutation presence only, with no node or content serialization. It is disconnected when no candidate remains and at shutdown.
12. The existing `window.error`/`unhandledrejection` listeners fan out one normalized observation to OTel and RUM. RUM uses a generic safe message and bounded error type; no arbitrary thrown object is serialized.
13. The existing official OTel fetch instrumentation remains the sole fetch patch. Its request hook signals activity; the existing synchronous URL policy span processor's `onEnd` reports sanitized method/path/status/failure to RUM.
14. All OTLP exporter URLs and the RUM URL are in the official fetch ignore list; the RUM observer also excludes these paths.
15. Common event construction reads the active valid OTel span context and includes lowercase nonzero trace and span IDs when available.
16. Browser globals are accessed only after checking `window`/`document`; listeners, timers, history wrappers, observer, and queue are owned and cleaned up by the runtime.
17. Tests will exercise the closed ingest contract, sensitive input and URL fixtures, batching, deterministic timers, lifecycle, and SSR import. RUM data is sanitized before queue insertion.
18. Public API change: optional `rum: { enabled: boolean }`, default off. OTel telemetry drafts and OTLP contracts stay unchanged.

Scroll emits 25%, 50%, 75%, 90%, and 100% milestones once per route, on a throttled listener. Release and target fields obey ingest's 128-byte safe-text rules; route obeys its strict pathname rule. Ingest currently accepts and discards RUM-2A events, so a 202 means admission rather than durability.

Correctness refinement: each dead-click candidate owns its creation time,
700 ms timer, position, target, and route. A fetch start can cancel only
candidates already active in that window; completion of a request started
before a click does not cancel the later candidate. The single browser error
listener fans out directly to OTel and RUM. Explicit `captureException()`
remains OTel-only.
