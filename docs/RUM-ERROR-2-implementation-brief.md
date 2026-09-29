# RUM-ERROR-2 implementation brief

## Audited contract (2026-09-28)

- SDK browser error listeners pass `ErrorEvent.error` or a safe message fallback, and `PromiseRejectionEvent.reason`, to `RumRuntime.observeError`. `normalizeRumError` currently returns only `error_type` and `message`; **this is the first stack discard**. The separate OTel `serializeError` path can carry a stack, but does not populate RUM.
- Ingest accepts `javascript_error.data` with required `error_type` and `message` and optional `stack`. Its strict JSON decoder validates stack as at most 4096 UTF-8 bytes, with no controls except LF/TAB and no `?` or `#`. It maps nonempty stack to the optional private protobuf field. Batch and body limits remain 100 events, 256 KiB compressed, and 1 MiB uncompressed.
- Storage's `JavaScriptError.stack = 3` is already optional. It validates the same 4096-byte/text contract, writes `error_stack Nullable(String)` to `events_v1`, and reads it through `SearchEvents` and `ListErrorOccurrences`. No protobuf or ClickHouse migration is needed.
- Storage's v1 fingerprint hashes only `error_type` and `message` for JavaScript errors. Its ClickHouse expression matches. Query independently calculates the same v1 identity from those two fields. Stack must stay outside both calculations.
- Query receives private stack but **discards it again** in `backend/internal/adapter/external/rumstorage/map.go:event()`. Its public domain `RUMJavaScriptError` and OpenAPI `RUMEvent.javascript_error` expose only type/message. Query tests assert that private stack is absent.
- Frontend's public event schema strips unknown `stack` values; Error Detail shows type/message and explicitly tests private-stack removal. A future display requires an additive, occurrence-only Query/OpenAPI DTO field, regenerated frontend contract/schema and a safe text renderer. Do not expose stack on group summaries or change the fingerprint.

## SDK change to implement after the plan gate

Add an optional `stack` to `normalizeRumError` only for actual `Error` instances with a browser-provided string stack. Keep existing name/message normalization byte-for-byte and the generic fallback for arbitrary rejection values. Do not read fields or call `String()`/`JSON.stringify()` on arbitrary objects. If a stack is missing, inaccessible, malformed, or yields no safe frames, omit it. Do not create one from filename/line, message, a nearby request, or an active span.

Parse only recognizable V8 and Firefox/Safari location frames. Drop the stack header (it duplicates the potentially user-controlled message), function names, eval/source excerpts, and unsupported locations. For each accepted frame, retain only an HTTP(S) JavaScript asset basename and positive numeric line/column from the browser's location. Strip URL query and fragment before output; reject residual `?`, `#`, controls, userinfo, non-HTTP(S) schemes and unsafe basenames. This conservative projection favors a reliable script/line diagnostic over exposing dynamic URL paths or application values. If a browser uses an unsupported stack format, omit stack rather than sending unreviewed text. Apply existing URL redaction rules at least as strictly as `sanitizeUrl`/`redactText`; do not feed an entire stack to `redactText`, whose 1024-character cap is intended for other text.

Explicit limits: inspect at most 16,384 UTF-16 code units of the provided string and at most 64 input lines; emit at most 32 frames/lines, 512 UTF-8 bytes per emitted line, and 4096 UTF-8 bytes total including LF separators. Truncate only at full code-point boundaries, and prefer dropping an overlong/malformed frame to emitting a partial location. No TAB or carriage return in output. These limits are below Ingest's stack and payload limits.

Keep `RumRuntime.observeError` and event transport otherwise unchanged. Its existing `trace_id`/`span_id` behavior reads only the currently active valid span; add no request-proximity matching or correlation synthesis. RUM-ERROR-1 message/type and arbitrary rejection behavior must remain compatible. Existing OTel error capture is out of scope.

## Later repository work (not authorized in this task)

- Ingest: no schema, decoder, or mapper change; keep existing validation and private sink contract.
- Storage: no schema or read-path change; add a cross-stack fixture if the later Query change needs one.
- Query: make an explicit privacy/product contract decision before exposing stack. Add optional occurrence-only `javascript_error.stack` to the public DTO/OpenAPI, validate the private 4096-byte field on read, project it only for authorized RUM error detail/occurrence endpoints, and update tests that currently forbid it. Session timeline exposure should remain a separate decision.
- Frontend: regenerate Query types, permit the optional field in the narrow occurrence schema, render as escaped text with preserved line breaks, and update tests that currently strip it. Keep private observation IDs and other infrastructure fields hidden.

## Privacy and compatibility

Stacks can contain messages, user input, query tokens, URL fragments, dynamic paths, source snippets, and identifiers. The SDK must emit only parsed frame locations. The projection above intentionally drops headers/function names and most URL path information; it may omit useful frames. Browser-provided stacks are not guaranteed to be truthful, so Ingest/Storage limits remain a second boundary and future Query exposure requires authorization and output escaping. Existing events without stack remain valid. The protobuf field and nullable database column already support both historical and new events. Fingerprint v1 and grouping remain unchanged because stack is non-identity data.
