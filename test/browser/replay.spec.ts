import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const bodies: string[] = [];
const policyRequests: number[] = [];
let app: Server;
let ingest: Server;
let appOrigin = "";
let ingestOrigin = "";
let enabled = true;
let exposeDate = true;
let policyFreshMs = 12_000;
let maxChunks = 64;
let replayStatuses: number[] = [];
let duplicateNext = false;
let holdReplay = false;
let enforceIngestDepth = false;
const heldReplayResponses: Array<() => void> = [];
test.use({ trace: "off" });

function releaseHeldReplayResponses(): void {
  for (const finish of heldReplayResponses.splice(0)) finish();
}

// Mirrors Ingest's scanJSON depth guard (root starts at zero).
function jsonDepth(value: unknown, depth = 0): number {
  if (!value || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((max, child) => Math.max(max, jsonDepth(child, depth + 1)), depth);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
}
test.beforeAll(async () => {
  const result = await build({ entryPoints: [resolve(here, "replay-fixture.ts")], bundle: true, format: "iife", platform: "browser", target: "es2020", write: false });
  const script = result.outputFiles[0]!.contents;
  app = createServer((request, response) => {
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); return; }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><body><div id="safe" title="attribute-secret" style="content:'css-secret'">static-secret-text</div><section data-sentinel-private><span>private-secret-text</span></section><input value="input-secret"><textarea>textarea-secret</textarea><select><option>select-secret</option></select><div contenteditable>editable-secret</div><a href="/path?token=url-secret">link</a><img src="/image?token=image-secret"><iframe src="about:blank"></iframe><canvas>canvas-secret</canvas><video src="/video?token=media-secret"></video><style>.x{content:'css-sheet-secret'}</style><script type="application/json">script-secret</script><script src="/fixture.js"></script></body></html>`);
  });
  ingest = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", appOrigin);
    response.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "private, no-store");
    if (exposeDate) response.setHeader("Access-Control-Expose-Headers", "Date");
    if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
    if (request.url === "/v1/rum/replay/policy") {
      policyRequests.push(Date.now());
      response.end(JSON.stringify(enabled ? { schema_version: 1, enabled: true, contract_version: 1, recorder_major: 2,
        fresh_until: new Date(Date.now() + policyFreshMs).toISOString(), limits: {
          max_wire_request_bytes: 262144, max_decoded_request_bytes: 1048576, max_events_per_chunk: 1000,
          max_chunks_per_replay: maxChunks, max_pages_per_replay: 16, max_decoded_replay_bytes: 16777216,
          max_promoted_duration_seconds: 900,
        } } : { schema_version: 1, enabled: false, fresh_until: new Date(Date.now() + policyFreshMs).toISOString() }));
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", part => parts.push(Buffer.from(part)));
    request.on("end", () => {
      if (request.url === "/v1/rum/replay/chunks") {
        const body = Buffer.concat(parts).toString("utf8");
        bodies.push(body);
        response.statusCode = enforceIngestDepth && jsonDepth(JSON.parse(body)) > 32 ? 413 : replayStatuses.shift() ?? 202;
        if (response.statusCode === 503 || response.statusCode === 429) response.setHeader("Retry-After", "1");
        const finish = () => response.end(response.statusCode === 202 ? `{"accepted":true,"duplicate":${duplicateNext ? "true" : "false"}}` : response.statusCode === 413 ? '{"error":"too_large"}' : '{"error":"fixture"}');
        if (holdReplay) heldReplayResponses.push(finish);
        else finish();
      } else { response.statusCode = 202; response.end('{"accepted":true}'); }
    });
  });
  appOrigin = await listen(app);
  ingestOrigin = await listen(ingest);
});
test.afterAll(async () => { releaseHeldReplayResponses(); await Promise.all([close(app), close(ingest)]); });
test.beforeEach(() => { releaseHeldReplayResponses(); bodies.length = 0; policyRequests.length = 0; enabled = true; exposeDate = true; policyFreshMs = 12_000; maxChunks = 64; replayStatuses = []; duplicateNext = false; holdReplay = false; enforceIngestDepth = false; });

test("deep real rrweb snapshot stays within Ingest's JSON nesting limit", async ({ page }) => {
  enforceIngestDepth = true;
  await page.goto(appOrigin);
  await page.evaluate(() => {
    const parent = document.createElement("main");
    let cursor = parent;
    for (let i = 0; i < 20; i++) {
      const child = document.createElement("section");
      cursor.append(child);
      cursor = child;
    }
    for (let i = 0; i < 340; i++) parent.append(document.createElement("span"));
    document.body.append(parent);
  });
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("@unkcode/sentinel/replay-continuity-v1"))).not.toBeNull();
  expect(await page.evaluate(() => window.replayFixture.status())).toBe("promoted");
  const first = JSON.parse(bodies[0]!) as { event_count: number; events: unknown[] };
  expect(Buffer.byteLength(bodies[0]!)).toBeGreaterThan(25_000);
  expect(Buffer.byteLength(bodies[0]!)).toBeLessThan(35_000);
  expect(first.event_count).toBeLessThanOrEqual(1000);
  expect(jsonDepth(first)).toBeLessThanOrEqual(32);
  expect(await page.evaluate(events => window.replayFixture.reconstruct(events), first.events)).toBe(true);
});

test("enabled policy refresh follows its server freshness deadline", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  expect(policyRequests).toHaveLength(1);
  await page.waitForTimeout(5000);
  expect(policyRequests).toHaveLength(1);
  expect(await page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await expect.poll(() => policyRequests.length, { timeout: 10_000 }).toBe(2);
  expect(policyRequests[1]! - policyRequests[0]!).toBeGreaterThan(7000);
});

for (const skewMs of [-60 * 60_000, 60 * 60_000]) {
  test(`server Date admits replay with browser clock skew of ${skewMs / 60_000} minutes`, async ({ page }) => {
    await page.addInitScript(skew => {
      const originalNow = Date.now.bind(Date);
      Date.now = () => originalNow() + skew;
    }, skewMs);
    await page.goto(appOrigin);
    await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
    await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
    await page.evaluate(() => window.replayFixture.trigger());
    await expect.poll(() => bodies.length).toBeGreaterThan(0);
  });
}

test("unexposed server Date fails closed", async ({ page }) => {
  exposeDate = false;
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("disabled-by-policy");
  await page.evaluate(() => window.replayFixture.trigger());
  expect(bodies).toHaveLength(0);
});

test("policy disabled never starts rrweb", async ({ page }) => {
  enabled = false;
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("disabled-by-policy");
  expect(bodies).toHaveLength(0);
});

test("adding a private marker after capture fails closed", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => document.querySelector("#safe")?.setAttribute("data-sentinel-private", ""));
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("privacy-blocked");
  await page.evaluate(() => window.replayFixture.trigger());
  expect(bodies).toHaveLength(0);
});

test("replay remains default-off without a local opt-in", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin, false), ingestOrigin);
  expect(await page.evaluate(() => window.replayFixture.status())).toBe("disabled");
  await page.evaluate(() => window.replayFixture.trigger());
  expect(bodies).toHaveLength(0);
});

test("sanitized checkpoint promotes once and continues after hard navigation", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.mutate());
  await page.evaluate(() => fetch("/request-body", { method: "POST", headers: { Authorization: "Bearer auth-header-secret" }, body: "request-body-secret" }).then(() => undefined));
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const first = JSON.parse(bodies[0]!) as { replay_id: string; page_id: string; sequence: number; trigger: { type: string }; events: { type: number }[] };
  expect(first.sequence).toBe(0);
  expect(first.trigger.type).toBe("javascript_error");
  expect(first.events.slice(0, 2).map(event => event.type)).toEqual([4, 2]);
  expect(first.events.some(event => event.type === 3)).toBe(true);
  expect(await page.evaluate(events => window.replayFixture.reconstruct(events), first.events)).toBe(true);
  expect(bodies.join(" ")).not.toMatch(/static-secret-text|dynamic-secret-text|private-secret-text|dynamic-private-secret|input-secret|textarea-secret|select-secret|editable-secret|attribute-secret|css-secret|url-secret|image-secret|canvas-secret|media-secret|shadow-secret|cookie-secret|local-storage-secret|session-storage-secret|css-sheet-secret|script-secret|auth-header-secret|request-body-secret/);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("@unkcode/sentinel/replay-continuity-v1"))).not.toBeNull();
  const stored = await page.evaluate(() => sessionStorage.getItem("@unkcode/sentinel/replay-continuity-v1"));
  expect(stored).toContain(first.replay_id);
  expect(stored).not.toMatch(/"events"|snapshot|"body"|secret|sip_pub_/i);
  await page.evaluate(() => window.replayFixture.emitSemanticTrigger("dead_click"));
  expect(new Set(bodies.map(body => (JSON.parse(body) as { replay_id: string }).replay_id))).toEqual(new Set([first.replay_id]));
  await page.reload();
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("promoted");
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(1);
  const second = JSON.parse(bodies.find((body, index) => index > 0 && JSON.parse(body).page_id !== first.page_id)!) as { replay_id: string; page_id: string; sequence: number; events: { type: number }[] };
  expect(second.replay_id).toBe(first.replay_id);
  expect(second.page_id).not.toBe(first.page_id);
  expect(second.sequence).toBe(0);
  expect(second.events.slice(0, 2).map(event => event.type)).toEqual([4, 2]);
});

for (const type of ["network_error", "rage_click", "dead_click"] as const) {
  test(`${type} semantic pipeline promotes the same recorder`, async ({ page }) => {
    await page.goto(appOrigin);
    await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
    await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
    await page.evaluate(value => window.replayFixture.emitSemanticTrigger(value), type);
    await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect((JSON.parse(bodies[0]!) as { trigger: { type: string } }).trigger.type).toBe(type);
  });
}

test("503 retries the identical chunk and 202 confirms it", async ({ page }) => {
  replayStatuses = [503, 202];
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(bodies[1]).toBe(bodies[0]);
});

test("429 and 500 retry with the same frozen body", async ({ page }) => {
  replayStatuses = [429, 500, 202];
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBe(3);
  expect(new Set(bodies).size).toBe(1);
});

test("exact duplicate 202 is accepted", async ({ page }) => {
  duplicateNext = true;
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("@unkcode/sentinel/replay-continuity-v1"))).not.toBeNull();
  expect(bodies).toHaveLength(1);
});

test("permanent replay responses stop without retries", async ({ page }) => {
  for (const status of [400, 403, 409, 410, 413, 415, 422]) {
    bodies.length = 0;
    replayStatuses = [status];
    await page.goto(appOrigin);
    await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
    await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
    await page.evaluate(() => window.replayFixture.trigger());
    await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe(status === 403 ? "disabled-by-policy" : "upload-failed");
    expect(bodies, `status ${status}`).toHaveLength(1);
    await page.evaluate(() => window.replayFixture.shutdown());
  }
});

test("navigation before the first 202 cannot continue an unconfirmed replay", async ({ page }) => {
  holdReplay = true;
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  const first = JSON.parse(bodies[0]!) as { replay_id: string; page_id: string; sequence: number };
  expect(first.sequence).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem("@unkcode/sentinel/replay-continuity-v1"))).toBeNull();
  await page.reload();
  holdReplay = false;
  releaseHeldReplayResponses();
  expect(await page.evaluate(() => sessionStorage.getItem("@unkcode/sentinel/replay-continuity-v1"))).toBeNull();
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  expect(bodies).toHaveLength(1);
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length).toBeGreaterThan(1);
  const second = JSON.parse(bodies[1]!) as { replay_id: string; page_id: string; sequence: number };
  expect(second.replay_id).not.toBe(first.replay_id);
  expect(second.page_id).not.toBe(first.page_id);
  expect(second.sequence).toBe(0);
});

test("a continued page counts only after its own first 202", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("@unkcode/sentinel/replay-continuity-v1"))).not.toBeNull();
  const first = JSON.parse(bodies[0]!) as { replay_id: string; page_id: string };
  holdReplay = true;
  await page.reload();
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("promoted");
  await expect.poll(() => bodies.length).toBeGreaterThan(1);
  const second = JSON.parse(bodies[1]!) as { replay_id: string; page_id: string; sequence: number };
  expect(second.replay_id).toBe(first.replay_id);
  expect(second.page_id).not.toBe(first.page_id);
  expect(second.sequence).toBe(0);
  await page.reload();
  holdReplay = false;
  releaseHeldReplayResponses();
  const continuity = JSON.parse((await page.evaluate(() => sessionStorage.getItem("@unkcode/sentinel/replay-continuity-v1")))!) as { replay: string; chunks: number; pages: number };
  expect(continuity.replay).toBe(first.replay_id);
  expect(continuity.chunks).toBe(1);
  expect(continuity.pages).toBe(1);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("promoted");
  await expect.poll(() => bodies.length).toBeGreaterThan(2);
  const third = JSON.parse(bodies[2]!) as { replay_id: string; page_id: string; sequence: number };
  expect(third.replay_id).toBe(first.replay_id);
  expect(third.page_id).not.toBe(second.page_id);
  expect(third.sequence).toBe(0);
});

test("credential rejection stops replay without retry", async ({ page }) => {
  replayStatuses = [401];
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("disabled-by-policy");
  expect(bodies).toHaveLength(1);
});

test("runtime policy disable stops capture and preserves semantic RUM", async ({ page }) => {
  policyFreshMs = 7000;
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  enabled = false;
  await expect.poll(() => page.evaluate(() => window.replayFixture.status()), { timeout: 10_000 }).toBe("disabled-by-policy");
  await page.evaluate(() => window.replayFixture.trigger());
  expect(bodies).toHaveLength(0);
  enabled = true;
  await expect.poll(() => page.evaluate(() => window.replayFixture.status()), { timeout: 12_000 }).toBe("buffering");
  expect(bodies).toHaveLength(0);
});

test("lowered server chunk limit stops an already promoted replay", async ({ page }) => {
  policyFreshMs = 7000;
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  maxChunks = 1;
  await expect.poll(() => page.evaluate(() => window.replayFixture.status()), { timeout: 10_000 }).toBe("limit-reached");
  expect(bodies).toHaveLength(1);
});

test("mutation-heavy capture stays bounded and chunks stay under request caps", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  const perf = await page.evaluate(() => {
    const before = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const started = performance.now();
    const parent = document.querySelector("#safe")!;
    for (let i = 0; i < 500; i++) {
      const item = document.createElement("span"); item.textContent = `heavy-secret-${i}`; parent.append(item);
    }
    return { mutationMs: performance.now() - started, beforeHeap: before };
  });
  const stats = await page.evaluate(() => window.replayFixture.bufferStats());
  const afterHeap = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize);
  console.log(`replay mutation fixture: ${JSON.stringify({ mutationMs: perf.mutationMs, heapDelta: afterHeap && perf.beforeHeap ? afterHeap - perf.beforeHeap : null, bufferBytes: stats.bytes, events: stats.events })}`);
  expect(perf.mutationMs).toBeLessThan(5000);
  expect(stats.bytes).toBeLessThanOrEqual(2 << 20);
  expect(stats.events).toBeLessThanOrEqual(5000);
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(Buffer.byteLength(body)).toBeLessThan(262144);
    expect((JSON.parse(body) as { event_count: number }).event_count).toBeLessThanOrEqual(1000);
    expect(body).not.toContain("heavy-secret");
  }
});

test("forced rrweb checkout creates another reconstruction group", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.bufferStats().groups)).toBe(1);
  await page.evaluate(() => window.replayFixture.forceCheckpoint());
  await expect.poll(() => page.evaluate(() => window.replayFixture.bufferStats().groups)).toBe(2);
  expect((await page.evaluate(() => window.replayFixture.bufferStats())).events).toBeGreaterThanOrEqual(4);
});

test("Chromium heap growth stays bounded during a mutation burst", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP heap metric is Chromium-only");
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heap = async () => (await cdp.send("Performance.getMetrics")).metrics.find(metric => metric.name === "JSHeapUsedSize")?.value ?? NaN;
  const before = await heap();
  await page.evaluate(() => {
    const parent = document.querySelector("#safe")!;
    for (let i = 0; i < 1000; i++) {
      const item = document.createElement("div"); item.textContent = `heap-secret-${i}`; parent.append(item);
    }
  });
  await page.waitForTimeout(200);
  const after = await heap();
  const stats = await page.evaluate(() => window.replayFixture.bufferStats());
  console.log(`replay CDP heap fixture: ${JSON.stringify({ before, after, delta: after - before, bufferBytes: stats.bytes, events: stats.events })}`);
  expect(Number.isFinite(after - before)).toBe(true);
  expect(after - before).toBeLessThan(32 << 20);
  await cdp.detach();
});

test("DOM-heavy initial snapshot starts and remains within prebuffer bounds", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(() => {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 1000; i++) {
      const item = document.createElement("div"); item.textContent = `dom-heavy-secret-${i}`; fragment.append(item);
    }
    document.body.append(fragment);
  });
  const started = Date.now();
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.bufferStats().groups)).toBe(1);
  const elapsedMs = Date.now() - started;
  const stats = await page.evaluate(() => window.replayFixture.bufferStats());
  console.log(`replay DOM startup fixture: ${JSON.stringify({ elapsedMs, bufferBytes: stats.bytes })}`);
  expect(elapsedMs).toBeLessThan(5000);
  expect(stats.bytes).toBeLessThanOrEqual(2 << 20);
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(bodies.join(" ")).not.toContain("dom-heavy-secret");
});
