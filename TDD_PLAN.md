# Sentinel SDK implementation and TDD gate

Status: **approved — implementation and verification complete**

This plan records the approved OpenTelemetry-wrapper implementation slices and
their verification requirements. Production implementation was authorized
after the architecture gate was approved.

## Test layers

- **Unit (Vitest):** config normalization, endpoint construction, public-key
  validation, attribute sanitization, reserved keys, `beforeSend`, lifecycle
  state machine, diagnostics redaction, error serialization.
- **Contract (Vitest + official in-memory/fake transport seams):** provider
  construction, official processors/readers, headers, resource attributes,
  exact signal URLs, force-flush/shutdown, and official OTLP payload behavior.
- **Browser integration (Playwright Chromium, Firefox, WebKit):** real fetch
  patching, W3C propagation, Zone context, recursion prevention, query/fragment
  privacy with pathname retention, distributed-trace headers, browser errors,
  unhandled rejections, page lifecycle, and duplicate
  initialization/instrumentation.
- **Package/API (publint, API Extractor or equivalent, TypeScript fixture
  projects):** exports, types, React peer isolation, ESM tree shaking, and no
  OpenTelemetry implementation types leaking from normal public signatures.
- **Bundle (esbuild metafile + gzip):** core and subpath budgets recorded in
  `ARCHITECTURE.md`.

Tests use a local mock OTLP HTTP collector. Assertions decode only payloads
produced by the official exporters; production code never serializes OTLP.

## Ordered implementation slices

1. **Scaffold and API contracts**
   - package exports for `.`, `./react`, and `./web-vitals`;
   - strict TypeScript in `src/**/*.ts` and `src/**/*.tsx`, ESM build,
     declaration generation, lint, and unit/browser test harnesses;
   - a repository check rejecting handwritten `.js`/`.mjs` under `src` and
     confirming generated JavaScript is confined to build output;
   - public config/result/error types and lifecycle state tests;
   - dependency and bundle-size lock checks.

2. **Validation and privacy primitives**
   - endpoint and `sip_pub_` validation;
   - URL/attribute/error sanitizer and reserved namespace enforcement;
   - synchronous `beforeSend` draft semantics;
   - fuzz/property tests for cycles, hostile getters, huge values, and secret
     key patterns.

3. **Official OpenTelemetry pipelines**
   - immutable resource;
   - official trace/log/metric providers, official batching processors/reader,
     and official OTLP/HTTP exporters using constructor configuration;
   - minimal synchronous fetch URL policy processor before the official trace
     batch processor, with no buffering/export behavior;
   - authorization header tests and negative assertions proving the key is not
     in resource, URL, payload, or diagnostics;
   - `flush()` and `shutdown()` behavior, timeouts, partial failure, and
     idempotence.

4. **Global ownership**
   - Sentinel-owned context, W3C propagator, and tracer registration, with the
     tracer registered last and checked official setter results;
   - deterministic conflict tests for context, propagator, tracer, and an
     already wrapped fetch;
   - bounded cleanup tests proving Sentinel disables only a context/propagator
     it installed during a failed synchronous initialization;
   - proof that logger and meter providers remain private and are not installed
     in global API slots;
   - same-config idempotence, different-config rejection, and duplicate package
     copy sentinel tests.

5. **Official fetch instrumentation**
   - configure the official package with explicit provider, ignore matchers,
     `tracePropagationTargets`, and the URL policy processor;
   - prove exporter requests do not create spans recursively;
   - prove no captured headers, bodies, query, or fragment;
   - for `fetch("/api/v2/comprobantes?token=secret")`, prove exported
     `url.full` is origin plus `/api/v2/comprobantes`, `url.path` retains that
     pathname, and `token=secret` is absent everywhere after `onStart`;
   - repeat the same assertions for
     `fetch(new Request("/api/v2/comprobantes?token=secret"))`;
   - prove the policy processor runs before the official batch processor and
     does not receive spans from unrelated instrumentation scopes;
   - prove same-origin propagation and cross-origin deny-by-default/allowlist;
   - prove an already wrapped fetch causes deterministic initialization failure
     rather than being wrapped again.

6. **Convenience APIs and browser errors**
   - safe logging facade over official loggers;
   - safe tracing facade over official tracers and active context;
   - metric conveniences over official meters;
   - `error` and `unhandledrejection` capture with correlation, deduplication,
     sanitization, listener cleanup, and preserved browser behavior.

7. **Optional entrypoints**
   - `/web-vitals` metric mappings and cleanup;
   - `/react` error boundary and hooks using the core instance;
   - tests proving neither entrypoint creates infrastructure and React is not
     bundled.

8. **Release hardening**
   - three-browser end-to-end matrix and adverse-network cases;
   - distributed trace acceptance test: capture an allowed request's W3C
     `traceparent`, validate its format, and match its trace ID and parent span
     ID to the exported frontend CLIENT span;
   - document/fixture the expected extraction by `sentinel-sdk-go` official
     `TraceContext` plus `otelhttp` middleware, without a custom correlation
     header;
   - package fixtures in Vite, webpack, and a minimal ESM consumer;
   - bundle budgets, source maps, license inventory, README examples, and API
     report;
   - verify the locked dependency graph has one compatible OpenTelemetry API
     instance and aligned `2.11.0`/`0.222.0` families.

## Required acceptance tests

The release candidate is blocked unless all of the following are automated:

- one init call produces exactly one provider and one exporter per signal;
- `Authorization: Bearer sip_pub_...` is present on all three export requests;
- the credential is absent from URLs, resource attributes, payload fields,
  thrown errors, and diagnostics;
- `/v1/logs`, `/v1/traces`, and `/v1/metrics` are constructed correctly with
  and without endpoint path prefixes;
- exporter calls generate zero fetch spans and zero recursive exports;
- string-form and `Request`-form fetch spans both retain
  `/api/v2/comprobantes` while query strings, fragments, Authorization, Cookie,
  Set-Cookie, and bodies are absent;
- W3C headers appear for same-origin and configured cross-origin targets only,
  subject to the documented same-origin invariant;
- an allowed request has a valid W3C `traceparent` whose trace ID and parent
  span ID match the exported frontend CLIENT span, establishing the standard
  wire contract consumed by the Go backend;
- an existing wrapped fetch is not wrapped twice and causes deterministic
  initialization failure;
- conflicts in the Sentinel-owned global context, propagator, or tracer slots
  fail deterministically without a duplicate pipeline;
- repeated init/flush/shutdown calls are deterministic and idempotent;
- reserved Sentinel attributes cannot be overridden through public APIs;
- `beforeSend` can rewrite/drop Sentinel drafts and cannot leak the key;
- browser errors and React errors are sanitized and trace-correlated;
- core, `/react`, and `/web-vitals` stay within their bundle budgets;
- no handwritten OTLP serializer, exporter, batching/export processor, log
  processor, metric reader, or context/trace propagation implementation exists
  in the production tree; the only custom trace processor is the approved
  synchronous fetch URL policy hook.

## Gate result

The architecture and implementation gate were approved. All slices and the
full verification suite are complete; publishing and external release remain
separate, explicitly unauthorized actions.
