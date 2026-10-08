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
- `replay.enabled` defaults to `false`. Replay also requires `rum.enabled` and a
  fresh enabled policy from Ingest for the exact public credential and Origin.

## Session replay recorder

Replay is opt-in with `rum: { enabled: true }, replay: { enabled: true }`. The SDK
reads `<endpoint>/v1/rum/replay/policy` with the public credential and records
only while its enabled v1 policy is fresh. The first semantic JavaScript error,
network error, rage click, or dead click promotes a bounded in-memory rrweb
checkpoint buffer. Chunks go only to `<endpoint>/v1/rum/replay/chunks`; a 202
response confirms persistence. There is no continuous replay upload.

Add `data-sentinel-private` to the root of every sensitive subtree **before**
recording begins. Its contents are blocked, including descendants and later
mutations. The recorder masks visible text and form values and strips captured
attributes; it excludes frames, canvas, media, scripts, styles, unsafe DOM
surfaces, plugins, cookies and browser storage values. This conservative
capture favors privacy over visual detail. Mark dynamic private roots before
attaching them to the document. The replay viewer itself must carry this marker
before recorder rollout.
Changing this marker on an existing element stops replay and discards local
buffers; it cannot retract chunks that Ingest has already accepted.

An unpromoted prebuffer is discarded on hard navigation. A promoted replay with
at least one acknowledged chunk can continue after a reload in the same tab and
Sentinel session: `sessionStorage`
contains only bounded replay identity/count metadata, never rrweb events,
snapshots or chunks. Each new document obtains a fresh policy and page ID with
its own FullSnapshot. A navigation before the first valid 202 cannot continue
that replay: the next document starts a fresh buffer and needs a new semantic
trigger. Page exit cannot guarantee delivery of in-flight chunks. Later pages
count toward continuation only after their own first chunk is acknowledged.
The SDK stops replay independently when policy, privacy, upload or size limits
fail; semantic RUM and OpenTelemetry remain active.
`sentinel.replayStatus()` exposes only a fixed local state, with no replay or
session identifiers.

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

`rage_click` represents at least three rapid, nearby interaction attempts on
one stable target. An attempt can be a native click or a short, completed
pointer press without a click (for example, on a disabled button). A press
that produces a click counts once. The serialized `click_count` field is a
legacy name for the number of attempts. `click` and `dead_click` retain their
existing browser-click behavior. Historical rage events were detected from
clicks only, so detection coverage changes with this SDK version.

RUM records pathname-only routes, normalized interaction positions, bounded semantic
target fields (`tag`, `role`, approved `data-testid`), and safe event metadata.
For small interactive controls, it also automatically captures the control's
own safe `aria-label` as `target.label`, or bounded visible control text as
`target.text` when no safe label exists. Each human-readable field is at most
80 UTF-8 bytes. Add `data-sentinel-private` to a control or ancestor to omit
these human-readable fields within the eight-element ancestor lookup; click-like events can still carry
safe tag, role, and test ID metadata. Input, textarea, select, password, and
contenteditable values or contents are never captured as target text.
Rage targets on non-interactive elements carry only safe semantic identifiers;
the SDK does not read arbitrary page text from them.
It never reads form values, arbitrary page text, HTML, cookies, request bodies, headers,
or storage contents other than its own session metadata. JavaScript error
messages are generic to avoid leaking application data. No user identity or
fingerprinting is included in semantic events. Replay snapshots are a separate,
explicitly enabled signal. Ingest derives tenant,
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
