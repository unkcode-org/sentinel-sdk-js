# @unkcode/sentinel

Privacy-safe browser telemetry for Sentinel, implemented as a thin TypeScript
wrapper around the official OpenTelemetry JavaScript SDK.

```ts
import { Sentinel } from "@unkcode/sentinel";

const sentinel = Sentinel.init({
  endpoint: "https://ingest.example.com",
  publicKey: "sip_pub_0000000000000000000000000000000000000000000",
  serviceName: "gofip-frontend",
  release: "1.0.0",
  rum: { enabled: true },
});

sentinel.info("checkout loaded", { cartSize: 2 });
await sentinel.startActiveSpan("checkout.submit", async span => {
  span.setAttribute("checkout.method", "card");
});
```

Sentinel configures official trace, log, and metric providers, batch
processors/readers, OTLP/HTTP exporters, W3C Trace Context, Zone context, and
fetch instrumentation. The public credential is sent only as an
`Authorization: Bearer` exporter header.

## Configuration

- `endpoint`, `publicKey`, and `serviceName` are required.
- `release`, `environment`, and `tracesSampleRate` set resource/sampling data.
- `tracePropagationTargets` allows additional cross-origin W3C propagation.
  Official fetch instrumentation always propagates to same-origin requests.
- `instrumentFetch` and `captureErrors` default to `true`.
- `beforeSend` synchronously rewrites or drops Sentinel-owned drafts after
  initial sanitization; its output is sanitized again.
- `diagnostics` defaults to `false`; enabled diagnostics are content-free and
  rate-limited.
- `rum.enabled` defaults to `false`; enabling it captures semantic browser RUM.

## Semantic browser RUM

Opt in with `rum: { enabled: true }`. The browser sends `page_view`, `click`,
`rage_click`, `dead_click`, `scroll_depth`, `javascript_error`, and
`network_error` events as schema v1 JSON to `<endpoint>/v1/rum/events`, using
the same public key in an Authorization header. It complements the existing
OpenTelemetry traces, logs, and metrics; it does not use OTLP.

The SDK creates a random tab-scoped session ID in `sessionStorage`, reuses it
across reloads, and rotates it after 30 minutes of inactivity. If storage is
blocked, it continues with an in-memory session. Events are batched at 20 or
every 5 seconds in a 200-event memory queue; overflow drops the oldest event.
Transient failures get one retry. Page lifecycle delivery uses authorized
`fetch` with `keepalive` and is best effort. A successful Ingest response in
RUM-2A confirms admission, not durable storage.

RUM records pathname-only routes, normalized click positions, bounded semantic
target fields (`tag`, `role`, approved `data-testid`), and safe event metadata.
It never reads form values, DOM text, HTML, cookies, request bodies, headers,
or storage contents other than its own session metadata. JavaScript error
messages are generic to avoid leaking application data. No user identity,
fingerprinting, replay, or DOM snapshots are included. Ingest derives tenant,
application, and environment scope from the public credential.

`javascript_error` comes from automatic `window.error` and
`unhandledrejection` observation. Calling `captureException()` explicitly
continues to emit OTel telemetry without claiming a browser RUM error.

Trace and span IDs are attached only when a valid OpenTelemetry context is
active at event creation. Ordinary DOM listeners may run in their registration
context, so interaction correlation is best effort.

Fetch pathnames are retained while queries, fragments, user information,
sensitive headers, and bodies are excluded. Sentinel owns the browser global
OpenTelemetry setup in 0.1.x and fails deterministically if incompatible global
tracing or existing fetch wrapping is detected.

## Optional entrypoints

`@unkcode/sentinel/react` exports `SentinelErrorBoundary`. React is an optional
peer dependency. `@unkcode/sentinel/web-vitals` exports `instrumentWebVitals`,
which records supported Web Vitals through an existing Sentinel instance.

Call `flush()` for an explicit best-effort export and `shutdown()` to disable
Sentinel-owned listeners, instrumentation, providers, and globals.
