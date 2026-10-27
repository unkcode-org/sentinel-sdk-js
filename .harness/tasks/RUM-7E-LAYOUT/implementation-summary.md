# Replay layout capture — 2026-10-27

The user reported an empty-looking Replay and requested usable playback while keeping Sentinel controls. The SDK previously stripped every attribute and all CSS, so no viewer could recover the original layout from stored chunks.

## Implementation and scope

`src/replay/layout.ts` projects computed dimensions, spacing, layout, typography and colors into a generated inline style. Only fixed property names and validated numeric/color/keyword values survive. Never retain source CSS, selectors, class names, custom properties, content, URLs, custom fonts or resource references. Use a fixed system font. Keep text length-independent masking and all existing private/unsafe subtree exclusions. Resolve private mirror ancestry before sampling the initial snapshot or any mutation, including rrweb blocked placeholders.

Snapshot/addition nodes and attribute mutations use this same projection before buffering. No raw event reference is retained. Stylesheet-only changes appear at the next checkpoint; images, SVG/media and webfonts remain excluded. This is layout recovery, not pixel-perfect asset replay. Existing recordings without styles remain unchanged. The transport contract, policy, quotas, byte/depth caps and retry behavior are unchanged. Large snapshots still stop locally. Load presentation code only with the recorder; release callbacks on stop.

## Manual architecture and security review

This SDK has no Harness kernel/compiler. Review is manual, following its existing RUM-7E convention. Layout capture remains isolated in `src/replay/`; semantic RUM, configuration and public exports are unchanged. No new dependency or network path is introduced. The frontend CSP and sandbox stay unchanged. The allowlist rejects URL/expression/var/attr/escape/declaration injection and text-bearing CSS. Private placeholders never invoke layout capture. Negative canaries cover source attributes, text, CSS content, URLs, forms, media, cookies and storage in Chromium, Firefox and WebKit. Presentation is classified as allowed capture data in the privacy-contract amendment.

## Evidence

The SDK browser fixture uploads sanitized rrweb data, reconstructs it, checks flex layout, 640px width and RGB background, then verifies an attribute-driven background mutation. The fixture exports sanitized events only, for a frontend checkpoint that proves those same styles in the production isolated player. The 1,000-element Chromium fixture used 179,211 buffer bytes and started in about 109 ms locally; this is test-fixture evidence, not a production performance guarantee. The original 256 KiB request cap remains enforced.

Full SDK verification passed (93 unit/contract, 175 browser passed / 2 skipped, package/build/type/lint and bundle budgets). After the final private-placeholder defense, the rerun passed 94 unit/contract tests and 76 Replay browser tests (2 Chromium-only metric cases skipped on Firefox/WebKit). Runtime changes require publishing/consuming a new SDK version and recording new sessions; no deployment or npm publication was performed.
