# RUM-7E architecture review — planning stage

Classification: high risk, browser privacy/security sensitive. Scope reviewed: SDK boundaries, Core/Ingest/Storage contracts, RUM-7F playback, lifecycle, limits, transport and tests. Planning result: conditional design. Implementation review result: SDK gates pass; production gates in `implementation-summary.md` remain open.

1. **Blocking authority gap:** no public endpoint exposes exact credential/Origin scoped replay policy or freshness to the SDK. Core v3 is private; Ingest OPTIONS is Origin-wide and lacks policy. Local `replay.enabled` cannot authorize capture. Future contract needed; no backend edit in this task.
2. **Record/replay compatibility:** pin rrweb 2.1.6; sequence 0 requires Meta+FullSnapshot; checkpoint group eviction maintains reconstruction. Validate with real browsers and RUM-7F fixture.
3. **Data path:** only Ingest write receives replay; identity JSON is supported; Ingest compresses event array internally. 202 is durable acknowledgement. Sequential frozen-body retries match Storage idempotency.
4. **Bounded resources:** 30s/2 MiB/5000-event prebuffer is a local target; actual memory and transient copies need measurement. Upload queue, aggregate limit accounting, page/sequence limits and stopped state avoid storms. No daily quota claim.
5. **Lifecycle:** one semantic session identity and trigger pipeline, no duplicate replay on repeated triggers. Hard navigation loses unpromoted context; promoted cross-document continuation requires a human product decision.
6. **Rollout gates:** RUM-7F private marker patch, RUM-7C real write-path E2E, privacy browser suite, performance evidence and explicit implementation approval all remain open. No production activation implied.

Repository process note: SDK has no Harness kernel/compiler, so this is a manual targeted review artifact, not a compiled Harness review result.
