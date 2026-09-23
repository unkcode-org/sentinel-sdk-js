# Sentinel SDK for JavaScript: OpenTelemetry wrapper architecture

Status: **approved and implemented for the v0.1.0 candidate**  
Audit date: 2026-09-22

## 1. Fixed decision and scope

`@unkcode/sentinel` is a browser-first, thin, opinionated wrapper over the
official OpenTelemetry JavaScript SDK. The decision to use OpenTelemetry is
closed:

```text
OpenTelemetry = telemetry engine
Sentinel = configuration + DX + privacy + integrations
```

Sentinel will not implement telemetry models, context propagation, trace
propagation, exporters, metric readers, batching processors, OTLP serialization,
OTLP retry, or OTLP transport. The one Sentinel policy processor described in
section 4 uses the official synchronous `SpanProcessor.onStart` extension point
only to remove URL query strings and fragments. It does not buffer, batch,
export, retry, or implement tracing.

Sentinel owns configuration, lifecycle, privacy policy, browser integrations,
and a small stable public API. OpenTelemetry remains an implementation detail
for the normal path.

The initial release targets modern browsers (ES2020 output). Build and test
tooling requires Node.js 20 or newer, but no Node telemetry SDK is shipped in
the browser package.

All production source is TypeScript under `src/**/*.ts` and `src/**/*.tsx`.
JavaScript `.js`/`.mjs` files are generated build artifacts only. The package
generates and publishes TypeScript declarations for every public entrypoint.

## 2. Dependency selection and compatibility

The following versions were checked against the npm registry and the official
package metadata on the audit date:

| Package | Selected version | Why it is required |
| --- | ---: | --- |
| `@opentelemetry/api` | `1.9.1` | Stable trace, context, propagation, and metrics APIs |
| `@opentelemetry/api-logs` | `0.222.0` | Official logs API; logs are still development-status upstream |
| `@opentelemetry/sdk-trace-web` | `2.11.0` | `WebTracerProvider`, official samplers and `BatchSpanProcessor` |
| `@opentelemetry/sdk-logs` | `0.222.0` | `LoggerProvider` and `BatchLogRecordProcessor` |
| `@opentelemetry/sdk-metrics` | `2.11.0` | `MeterProvider` and `PeriodicExportingMetricReader` |
| `@opentelemetry/exporter-trace-otlp-http` | `0.222.0` | Official trace OTLP/HTTP exporter |
| `@opentelemetry/exporter-logs-otlp-http` | `0.222.0` | Official log OTLP/HTTP exporter |
| `@opentelemetry/exporter-metrics-otlp-http` | `0.222.0` | Official metric OTLP/HTTP exporter |
| `@opentelemetry/instrumentation-fetch` | `0.222.0` | Official browser `fetch` instrumentation |
| `@opentelemetry/instrumentation` | `0.222.0` | Instrumentation lifecycle and public `isWrapped` duplicate-patch check |
| `@opentelemetry/context-zone` | `2.11.0` | Official asynchronous browser context manager |
| `@opentelemetry/core` | `2.11.0` | Official W3C Trace Context propagator implementation |
| `@opentelemetry/resources` | `2.11.0` | Official resource creation and merging |
| `@opentelemetry/semantic-conventions` | `1.43.0` | Official attribute constants |
| `web-vitals` | `6.2.2` | Web Vitals callbacks, isolated to the `/web-vitals` entrypoint |

Compatibility is deliberate: the stable SDK line is `2.11.0`, its matching
experimental line is `0.222.0`, and their peer ranges all admit API `1.9.1`.
The experimental packages are exact-pinned because minor releases may break
their APIs. Dependabot/Renovate updates must update the stable and experimental
families together and pass the browser contract suite.

`@opentelemetry/api` should be a non-optional peer dependency with range
`>=1.9.0 <1.10.0`, and also a development dependency at `1.9.1`. This preserves
the singleton API expected by an application that already uses OpenTelemetry.
React is a peer dependency of `/react`, not bundled by Sentinel. Everything
else above is a direct dependency because Sentinel imports it directly.

The official fetch instrumentation pulls Node interception helpers transitively
through `@opentelemetry/instrumentation`. They are not used by Sentinel and are
removed from the browser bundle by the official platform entrypoints and tree
shaking. Sentinel will not add Node auto-instrumentation bundles.

Authoritative references:

- [OpenTelemetry JavaScript API reference](https://open-telemetry.github.io/opentelemetry-js/)
- [OpenTelemetry browser guide](https://opentelemetry.io/docs/languages/js/getting-started/browser/)
- [OpenTelemetry JavaScript 2.x migration guide](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md)
- [Official fetch instrumentation source](https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/opentelemetry-instrumentation-fetch/src/fetch.ts)
- [Official `SpanProcessor` API](https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_sdk-trace-base.SpanProcessor.html)

## 3. Runtime composition

`Sentinel.init()` validates all input before creating or globally registering
anything. It then creates one immutable OpenTelemetry `Resource` with:

- `service.name` from `serviceName`;
- `service.version` from `release`, when supplied;
- `deployment.environment.name`, when supplied;
- the standard telemetry SDK attributes supplied by OpenTelemetry;
- a small Sentinel SDK name/version marker, never the credential.

The public key is accepted only when it matches
`^sip_pub_[A-Za-z0-9_-]{43}$`. It exists in the private runtime configuration
and exporter header objects only. It is never placed in a URL, resource, span,
log record, metric, exception, or diagnostic.

The three signal pipelines share the resource but have separate providers and
exporters:

| Signal | Provider | Processor/reader | Exporter URL |
| --- | --- | --- | --- |
| Traces | `WebTracerProvider` | Sentinel URL policy processor, then official `BatchSpanProcessor` | `<endpoint>/v1/traces` |
| Logs | `LoggerProvider` | `BatchLogRecordProcessor` | `<endpoint>/v1/logs` |
| Metrics | `MeterProvider` | `PeriodicExportingMetricReader` | `<endpoint>/v1/metrics` |

OpenTelemetry 2.x construction APIs are used: `spanProcessors`, `processors`,
and `readers` are supplied in provider constructors. The trace processor order
is URL policy first and official batching second. Removed mutation APIs such as
`addSpanProcessor()` and `addMetricReader()` are not used.

Trace sampling uses official `ParentBasedSampler` with an official
`TraceIdRatioBasedSampler` root. `tracesSampleRate` defaults to `1` for a
predictable first release and accepts a value from `0` through `1`.

Initial batching defaults are intentionally close to upstream defaults and are
bounded for the browser:

- traces: queue 2,048, batch 512, delay 5 seconds, export timeout 10 seconds;
- logs: queue 2,048, batch 512, delay 1 second, export timeout 10 seconds;
- metrics: interval 60 seconds, export timeout 10 seconds, cardinality limit
  2,000 series per instrument;
- each OTLP exporter: timeout 10 seconds and concurrency limit 2.

The limits may later become advanced Sentinel options without exposing the
OpenTelemetry classes.

Each official exporter receives exactly:

```ts
{
  url: signalUrl,
  headers: { Authorization: `Bearer ${publicKey}` },
  timeoutMillis: 10_000,
  concurrencyLimit: 2,
}
```

The endpoint validator rejects credentials, query strings, and fragments in
the configured base endpoint. It requires HTTPS, with an explicit development
exception for loopback hosts. Signal URLs are constructed with the URL API and
preserve an endpoint path prefix.

The application must configure CORS at Sentinel Ingest to allow `POST`,
`content-type`, and `authorization` from the application origin.

## 4. Fetch instrumentation, recursion, and propagation

Sentinel creates the official `FetchInstrumentation` with `enabled: false`,
sets the Sentinel tracer provider explicitly, and enables it only after
successful initialization. It does not write a replacement fetch wrapper.

Exporter recursion is prevented in three layers:

1. all three concrete exporter URLs are added to `ignoreUrls` using escaped,
   anchored matchers;
2. official OpenTelemetry batch processors/readers and exporters suppress
   tracing while exporting;
3. browser tests assert that an export creates no fetch span or recursive
   export even when global `fetch` is instrumented.

No request or response header capture is enabled. Request and response bodies
are never captured. `measureRequestSize` is off by default.

`tracePropagationTargets` configures `propagateTraceHeaderCorsUrls`. String
targets are normalized to exact URL-prefix regular expressions; callers may
also pass regular expressions. Exporter URLs are forbidden as propagation
targets.

Official fetch instrumentation always propagates W3C headers to same-origin
requests, regardless of `propagateTraceHeaderCorsUrls`. This behavior is
accepted for v0.1.0. `tracePropagationTargets` is therefore the allowlist for
**additional cross-origin** propagation; the current application origin is
always an implicit target. Cross-origin propagation is deny-by-default.
Sentinel will not introduce custom propagation or custom fetch instrumentation
to change this behavior.

### Pathname-preserving URL sanitization

The official instrumentation normalizes both string and `Request` inputs, then
initially assigns that URL to `url.full`. Its `requestHook` and
`applyCustomAttributesOnSpan` hooks receive `Request | RequestInit`, not the
normalized URL. For string-form `fetch`, they receive only `RequestInit`, so
those hooks cannot reliably recover the pathname. This is the exact upstream
limitation in `@opentelemetry/instrumentation-fetch@0.222.0`.

Sentinel will use the next official extension point: a minimal synchronous URL
policy processor implementing the public `SpanProcessor` contract. Its
`onStart` callback runs immediately after the official fetch instrumentation
creates a recording span and can read the initial `url.full` attribute and call
the official span `setAttribute` API. For spans whose instrumentation scope is
`@opentelemetry/instrumentation-fetch`, it parses the URL and replaces:

```text
https://api.example.com/api/v2/comprobantes?token=secret#fragment
```

with:

```text
https://api.example.com/api/v2/comprobantes
```

It also sets the applicable official `url.scheme`, `server.address`,
`server.port`, and `url.path` semantic attributes from that sanitized URL.
User information, query, and fragment are omitted. Relative URLs have already
been normalized by the official instrumentation, so both forms behave the
same:

```ts
fetch("/api/v2/comprobantes?token=secret");
fetch(new Request("/api/v2/comprobantes?token=secret"));
```

The URL policy processor is registered before the official
`BatchSpanProcessor`, performs no buffering or export, and has no-op lifecycle
methods. The official fetch instrumentation still owns span creation and
timing; the official batch processor and OTLP exporter still own batching and
export. This is the smallest standards-compatible adaptation and does not wrap
or replace `fetch`.

There is no current official built-in attribute-filter processor. The initial
full URL exists transiently inside the official SDK span until the synchronous
`onStart` policy callback runs; it is sanitized before application hooks,
span completion, batching, or export. Sentinel's fixed official sampler does
not inspect URL attributes. Tests assert the full secret-bearing value never
reaches the batch processor, exporter request, payload, or diagnostics.

Request and response bodies are never captured. Authorization, Cookie, and
Set-Cookie headers are never captured.

## 5. Privacy and `beforeSend`

One sanitizer module is used at every Sentinel-owned ingress: logs, manual
spans, span events, captured browser errors, React errors, and Web Vitals.
Defaults include:

- reject or truncate non-finite, deeply nested, oversized, or excessive data;
- accept only OpenTelemetry attribute scalar/array types after normalization;
- redact configured key patterns such as password, token, secret, cookie, and
  authorization;
- sanitize URL-like values to origin plus pathname;
- enforce attribute count and string length limits in both Sentinel and the
  official providers;
- serialize `Error` values into a bounded exception type/message/stack shape;
- never inspect DOM text, form values, storage, cookies, or request bodies.

The `sentinel.*`, `telemetry.sdk.*`, and resource identity namespaces are
reserved. Signal-specific semantic attributes set by Sentinel integrations are
also protected. User attributes go through a copy operation; reserved values
cannot be overwritten. Raw access through the advanced provider escape hatch
is explicitly outside this protection boundary.

`beforeSend` is a synchronous hook over Sentinel's mutable, sanitized draft,
before it is emitted into OpenTelemetry. It may return a replacement draft or
`null` to drop it. Hook exceptions are swallowed, safely diagnosed, and cause
that item to be dropped. The hook never receives the public key.

This hook applies to Sentinel-generated telemetry only. It does not mutate
arbitrary third-party telemetry. The narrowly scoped URL policy processor in
section 4 applies only to spans from the official fetch instrumentation.

## 6. Global OpenTelemetry interoperability

The only v0.1.0 mode is the primary supported path: Sentinel owns the browser
OpenTelemetry setup. `globalRegistration: "none"` is deferred. OpenTelemetry
2.x cannot add processors/readers to arbitrary existing providers after their
construction, and a private parallel mode would create extra lifecycle,
correlation, and duplicate-instrumentation cases that are not justified for the
first release.

Sentinel keeps its logger and meter providers as direct private references;
they do not need to occupy the global logger or meter API slots. Sentinel
registers only the infrastructure required for browser tracing and propagation:

- the official `ZoneContextManager`;
- the official W3C Trace Context propagator;
- Sentinel's `WebTracerProvider`.

Baggage propagation is deliberately not enabled by default because arbitrary
application baggage may contain sensitive data. `WebTracerProvider.register()`
is not used because it does not expose checked results for every global slot.

Registration is synchronous and deliberately small. Sentinel registers the
context manager, then propagator, then tracer provider, checking each official
setter result. The tracer provider is last so a failed context/propagator check
cannot leave the OpenTelemetry trace proxy delegated to Sentinel. On failure,
Sentinel calls the official `disable()` API only for a context or propagator it
just installed, shuts down its unregistered providers, and throws a typed
`SentinelInitializationError`. There is no general-purpose global registry or
provider-merging layer.

Before any global mutation, Sentinel checks the official public
`isWrapped(globalThis.fetch)` when fetch instrumentation is enabled. An already
wrapped fetch is treated as incompatible infrastructure and initialization
fails; Sentinel never silently double-wraps or silently loses automatic fetch
telemetry. `instrumentFetch: false` bypasses this check and does not patch
fetch.

Repeated `Sentinel.init()` with an equivalent normalized configuration returns
the same instance. A second call with different configuration throws. A global
symbol keyed by the Sentinel package major prevents duplicate Sentinel package
copies from installing duplicate infrastructure.

`globalRegistration: "none"` may be reconsidered after v0.1.0 only with a
separate, concrete interop contract. Until then, applications that already own
global OpenTelemetry infrastructure receive a deterministic initialization
error instead of a partial or duplicate Sentinel pipeline.

An advanced read-only `sentinel.openTelemetry` object may expose the three
provider instances for integration, but Sentinel does not re-export provider,
processor, reader, or exporter constructors.

## 7. Public API and lifecycle

The normal API remains Sentinel-shaped:

```ts
const sentinel = Sentinel.init({
  endpoint: "https://ingest.example.com",
  publicKey: "sip_pub_0000000000000000000000000000000000000000000",
  serviceName: "gofip-frontend",
  release: "1.0.0",
});

sentinel.info("checkout loaded", { cartSize: 2 });
await sentinel.startActiveSpan("checkout.submit", async span => {
  span.setAttribute("checkout.method", "card");
});
await sentinel.flush();
```

The exposed span facade supports safe attributes, events, status, exception
recording, and end; it does not expose the concrete SDK span type. Logging
methods map to official log severity numbers and emit via a logger obtained
from the private `LoggerProvider`. Metric conveniences similarly use a meter
from the private `MeterProvider`.

Automatic `error` and `unhandledrejection` listeners emit sanitized official
log records correlated with the active context. They neither prevent browser
default handling nor patch the console. Listener installation is idempotent.

`flush()` concurrently calls the official force-flush APIs on all three
providers and reports a bounded aggregate error. `shutdown()` disables
Sentinel-owned instrumentation/listeners, flushes, shuts down all official
providers, and disables the tracer, propagator, and context globals that
Sentinel owns. Logger and meter providers were never registered globally. Both
operations are idempotent. A best-effort page-hide flush is registered, but no
delivery claim is made after the browser terminates a page.

Diagnostics are off by default. When enabled they use a bounded Sentinel
adapter for the official diagnostic API, never include bodies, raw URLs,
headers, telemetry payloads, or credentials, and rate-limit repeated failures.

## 8. Entrypoints

| Entrypoint | Responsibility |
| --- | --- |
| `@unkcode/sentinel` | Configuration, all three providers/exporters, fetch instrumentation, browser error capture, logging/tracing/metric conveniences, privacy, lifecycle |
| `@unkcode/sentinel/react` | Error boundary and React hooks/components; consumes an existing core instance; React remains a peer |
| `@unkcode/sentinel/web-vitals` | `web-vitals` callbacks mapped to official histogram/counter instruments through an existing core instance |

Future framework entrypoints such as `/next` or `/vue` may translate framework
events into the core public API. They must not create providers, exporters,
global context managers, or duplicate fetch instrumentation. Node/server
support, if added, will be a separate entrypoint with the official Node SDK and
is outside the initial browser architecture.

Production and generated output use this approximate layout:

```text
src/
  index.ts
  sentinel.ts
  config.ts
  telemetry/
    resource.ts
    traces.ts
    logs.ts
    metrics.ts
    global-registration.ts
  instrumentation/
    fetch.ts
    errors.ts
  privacy/
    sanitizer.ts
    fetch-url-span-processor.ts
  react/
    index.ts
    error-boundary.tsx
  web-vitals/
    index.ts

dist/
  index.js
  index.d.ts
  react/
    index.js
    index.d.ts
  web-vitals/
    index.js
    index.d.ts
```

Tests and build configuration live outside `src`. The build emits tree-shakable
ESM JavaScript and declaration files; no handwritten production `.js` or `.mjs`
files are permitted.

## 9. Distributed trace interoperability

Sentinel uses only standard W3C Trace Context. No Sentinel-specific correlation
header is introduced. For an allowed same-origin request, or an allowed
cross-origin request matched by `tracePropagationTargets`, the official fetch
instrumentation injects a valid `traceparent` header.

The browser acceptance test captures the outgoing request and the exported
frontend CLIENT span. It validates the W3C header shape and proves that the
header trace ID and parent ID match that span:

```text
Browser / sentinel-sdk-js
frontend CLIENT span
trace_id = ABC
span_id = FRONTEND

        | traceparent: 00-ABC-FRONTEND-<flags>
        v

Go backend / sentinel-sdk-go
backend SERVER span
trace_id = ABC
parent_span_id = FRONTEND
```

`sentinel-sdk-go` already installs the official W3C `TraceContext` propagator
and uses official `otelhttp` middleware, so its expected behavior is to extract
that header, retain `ABC` as the trace ID, and use `FRONTEND` as the server
span's parent. JS tests prove the emitted wire contract; an optional
cross-repository integration test may prove the Go extraction end to end.

## 10. Browser bundle impact

The audit installed the exact graph above and bundled representative live code
with esbuild 0.25.9, ESM, browser platform, ES2020, minification, and gzip -9.
These figures include transitive OpenTelemetry code but not Sentinel's code:

| Representative pipeline | Minified | Gzipped |
| --- | ---: | ---: |
| Trace + OTLP + fetch + Zone context | 112.9 kB | 36.8 kB |
| Logs + OTLP | 44.0 kB | 13.7 kB |
| Metrics + OTLP | 71.0 kB | 20.6 kB |
| Combined core with shared-code deduplication | 182.7 kB | 55.5 kB |
| `/web-vitals` incremental library code | 9.0 kB | 3.4 kB |
| Minimal `/react` wrapper, React external | 0.1 kB | 0.2 kB |

Signal rows are not additive; the combined measurement demonstrates shared
deduplication. The first implementation gate sets budgets of 200 kB minified /
65 kB gzip for core, 5 kB gzip incremental for `/web-vitals`, and 3 kB gzip
incremental for `/react` excluding peer dependencies. CI records metafiles and
fails on budget regression.

RUM-2B adds an opt-in semantic browser runtime to the same public entrypoint.
Its added code raises the core minified budget to 210 kB; the 65 kB gzip
budget and both optional-entrypoint budgets remain unchanged.

The package emits ESM, marks only real side-effect modules appropriately, uses
explicit subpath exports, and never exposes an all-instrumentations bundle.

## 11. Explicit non-goals

- custom spans, logs, or metric data models;
- custom OTLP JSON/protobuf generation or HTTP/retry stack;
- custom batching/export processors, log processors, metric readers, or
  context/trace propagation;
- any policy processor beyond the narrowly scoped synchronous fetch URL
  sanitizer approved in section 4;
- console interception, DOM/session replay, header/body capture;
- Node auto-instrumentation in the browser entrypoint;
- silently attaching exporters to an existing provider;
- re-exporting OpenTelemetry as Sentinel's public API.

## 12. Human gate

Production implementation must not start until a human approves this document
and the companion TDD plan. Same-origin propagation is already accepted for
v0.1.0. The remaining architecture approval is the minimal official
`SpanProcessor.onStart` URL policy adaptation described in section 4, including
the fact that the full URL exists transiently inside the official SDK span
until that synchronous callback sanitizes it.
