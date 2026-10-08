# RUM-7E TDD and real-browser verification plan

Status: **approved and executed locally**. Ingest OpenAPI 0.7.0 resolved the policy discovery contract. For each slice: write failing contract/unit/browser test, implement the minimum code, run focused tests, then regression and review. Mock policy and Ingest for SDK development; never interpret mocks as the separate RUM-7C real write E2E. Final results are in `implementation-summary.md`.

## Test fixtures and invariants

Use a local HTTPS or loopback test origin and a mock credential-scoped policy route matching the future approved contract. Capture rrweb `emit` output before any network upload and the exact request bytes at mock Ingest. Build canary DOM with distinct secret strings in text, attributes, URLs, CSS, forms, private subtrees, dynamically inserted nodes, shadow roots, media and frames. Assert canaries absent from **every emitted accepted event, prebuffer checkpoint group, sealed chunk, retry body and console diagnostic**. Also assert a surviving safe visual marker and RUM-7F reconstruction where applicable. Run the existing Chromium, Firefox and WebKit Playwright projects; document any actual supported-browser exclusion before changing coverage.

## Red/green slices

| Slice | First failing tests | Required green evidence |
|---|---|---|
| A. Feature/policy | default SDK and `rum.enabled` alone, fresh enabled scoped policy, malformed/unknown v3, unsupported contract/recorder major, stale/expired, credential denied, Origin denied, runtime disable, lowered limits, disabled→enabled | No rrweb import/start without explicit local opt-in **and** fresh server authority; immediate stop on revocation; one refresh owner; semantic RUM keeps working |
| B. Privacy | input types/password, textarea, select, contenteditable, visible text, private subtree static/dynamic/attribute mutations, href/src/srcset/query/hash, CSS URL/content, cookies/storage, iframe, canvas, audio/video, scripts, open/closed shadow DOM, dynamic unsafe nodes | Negative canary checks at emitted event and retained buffer boundaries; unsupported surfaces blocked; RUM-7F panel absent; sanitized output replayable |
| C. Buffer | 30s clock eviction; 2 MiB UTF-8 byte pressure; 5000-event pressure; checkout by time/count; oversized single group; mutation-heavy burst; no trigger; repeated checkout | Whole groups removed; oldest retained begins Meta+FullSnapshot; no orphan mutation; bound count/bytes/time; unpromoted buffer freed |
| D. Trigger | each of four semantic types; exact semantic event ID; first and repeated trigger; semantic queue overflow/failure; 30-minute session rollover | One replay root and trigger; original semantic event still emitted; no second detection algorithm or upload |
| E. Chunking | sequence 0 anchor; ordering across chunks/checkouts; page-local monotonic sequence; event timestamp bounds; max effective events/decoded whole envelope/wire; oversized anchor; lower policy; retry same bytes; hard navigation | Every transmitted body accepted by Ingest decoder fixture; `final`/`truncated` frozen; no gap/drop-middle continuation; page/replay IDs valid UUIDs |
| F. Upload | 202 new and duplicate; 400, 401, 403, 409, 410, 413, 415, 422, 429, 500, 503 with/without Retry-After; timeout, abort, teardown; retry deadline | Only 202 counts accepted; exact body retry; bounded jitter/backoff and one in-flight request; terminal codes stop; no public payload errors |
| G. Cumulative limits | 64 chunks, 16 pages, 16 MiB decoded event data, 900s, each lower effective policy, lowered mid-session | Stop before known exceedance, keep accepted prefix, no replacement replay ID, semantic RUM continues; Storage rejection remains authoritative |
| H. Lifecycle | pagehide, hidden→visible, SPA route, hard navigation, teardown during import/recording/upload/retry, AbortController | No unload success assumption; no orphan listeners/timers/fetch; new document has new page anchor; no raw persistence |
| I. Performance | disabled bundle/static import scan, dynamic split chunk, startup timing, DOM-heavy initial snapshot, mutation-heavy throughput, 30s buffer heap peak, promotion/serialization/upload long tasks | Measured baselines and explicit thresholds agreed before rollout; disabled path does not execute rrweb; no unbounded growth |
| J. Regression | current semantic RUM browser suite including pointer-attempt rage behavior, OTel logs/traces/metrics, W3C propagation, credential/Origin, SDK public API, SSR | Existing `npm run verify` passes; replay failure cannot break other signals or app behavior |

## Real browser evidence (mandatory)

1. Enable from a fresh mock server policy, observe initial rrweb Meta and FullSnapshot, then an incremental DOM mutation. Force time and count checkouts; inspect group boundaries and evict under each independent cap. Feed resulting retained suffix and sealed chunks to the pinned RUM-7F player fixture and verify reconstruction of a safe mutation.
2. On a private DOM fixture, assert secret canaries never appear in initial snapshot, incrementals, frozen body or replayed DOM. Include dynamic insertion and mutation after the private marker, plus the actual `ReplayPanel` root once its separate patch lands. Test iframe, shadow DOM, CSS, URLs and form controls on all supported engines.
3. Trigger each semantic issue through the real SDK pipeline (including trusted pointer attempts for rage and the existing dead-click timing), prove promotion starts at an anchor, semantic event still uploads, repeated trigger does not create a second root, and post-trigger recording is bounded.
4. Navigate hard before a trigger and after promotion; show unpromoted old document history is discarded, new document gets its own page ID/anchor under the selected cross-document decision, and teardown cancels in-flight/retry operations. Run disabled-policy page and prove no recorder start or import.
5. Stress a DOM-heavy page and mutation-heavy fixture; record startup/promotion long tasks, per-chunk serialization time, heap before/after eviction, queue maximum, and upload bytes. Do not equate decoded byte count with heap.

## Verification order and release gates

During implementation: focused Vitest → Playwright Chromium/Firefox/WebKit → `npm run verify` (source layout, unit/contract tests, browser tests, types, lint, package validation, bundle budget) → targeted architecture/security/privacy review. Add contract fixtures copied from the audited Ingest decoder/OpenAPI, with a drift check or explicit review whenever backend contracts change. Do not snapshot secrets into test artifacts or Playwright traces.

Even a green SDK suite does **not** close RUM-7C: separately prove real HTTP chunk → Ingest → mTLS → Storage → ClickHouse + MinIO, preferably Query manifest/chunk round trip. Production activation additionally waits for authoritative policy discovery, RUM-7F self-block patch, privacy proof, performance acceptance and human rollout approval. No deployment or publish is part of RUM-7E planning.
