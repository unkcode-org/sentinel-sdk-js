# RUM-8 implementation evidence — 2026-10-29

Exact 429 quota_exceeded stops Replay with terminal quota-exceeded state. Operational 429/500/503 retains bounded retries. No capture/privacy/rendering change, version bump or publication.

PASS: typecheck, 99 unit tests, lint, package/type validation, bundle budget; nine targeted browser runs across Chromium/Firefox/WebKit verify one quota attempt and operational retries. Full visual browser suite not rerun because capture code is unchanged. Semantic RUM after quota is proven through both actual Ingest processes in Storage E2E. No npm publication/deploy.
