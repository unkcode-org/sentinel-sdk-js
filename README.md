# @unkcode/sentinel

Privacy-safe browser telemetry for Sentinel, implemented as a thin TypeScript
wrapper around the official OpenTelemetry JavaScript SDK.

```ts
import { Sentinel } from "@unkcode/sentinel";

const sentinel = Sentinel.init({
  endpoint: "https://ingest.example.com",
  publicKey: "sip_pub_...",
  serviceName: "gofip-frontend",
  release: "1.0.0",
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
