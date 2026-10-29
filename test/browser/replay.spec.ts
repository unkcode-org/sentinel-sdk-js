import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const bodies: string[] = [];
const policyRequests: number[] = [];
const wireBodies: Buffer[] = [];
let app: Server;
let ingest: Server;
let appOrigin = "";
let ingestOrigin = "";
let enabled = true;
let exposeDate = true;
let policyFreshMs = 12_000;
let maxChunks = 64;
let maxWire = 262144;
let maxDecoded = 1048576;
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
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.url === "/visual.css") {
      response.setHeader("Content-Type", "text/css");
      response.end('@font-face{font-family:ReplayFixture;src:url("/public.ttf") format("truetype")} .visual-grid{display:grid;grid-template-columns:120px 240px;gap:16px;background:rgb(12,34,56);font-family:ReplayFixture} .visual-grid img{width:32px;height:32px} .visual-grid::after{content:"css-content-secret"}');return;
    }
    if (request.url === "/public.svg") { response.setHeader("Content-Type", "image/svg+xml");response.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>');return; }
    if (request.url === "/public.ttf") { response.setHeader("Content-Type", "font/ttf");response.end(readFileSync(resolve(here,"../../node_modules/playwright-core/lib/vite/recorder/assets/codicon-DCmgc-ay.ttf")));return; }
    if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); return; }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><body><div id="safe" title="attribute-secret" style="content:'css-secret'">static-secret-text</div><section data-sentinel-private><span>private-secret-text</span></section><input value="input-secret"><textarea>textarea-secret</textarea><select><option>select-secret</option></select><div contenteditable>editable-secret</div><a href="/path?token=url-secret">link</a><img src="/image?token=image-secret"><iframe src="about:blank"></iframe><canvas>canvas-secret</canvas><video src="/video?token=media-secret"></video><style>.x{content:'css-sheet-secret'}</style><script type="application/json">script-secret</script><script src="/fixture.js"></script></body></html>`);
  });
  ingest = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", appOrigin);
    response.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Content-Encoding");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "private, no-store");
    if (exposeDate) response.setHeader("Access-Control-Expose-Headers", "Date");
    if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
    if (request.url === "/v1/rum/replay/policy") {
      policyRequests.push(Date.now());
      response.end(JSON.stringify(enabled ? { schema_version: 1, enabled: true, contract_version: 1, recorder_major: 2,
        fresh_until: new Date(Date.now() + policyFreshMs).toISOString(), limits: {
          max_wire_request_bytes: maxWire, max_decoded_request_bytes: maxDecoded, max_events_per_chunk: 1000,
          max_chunks_per_replay: maxChunks, max_pages_per_replay: 16, max_decoded_replay_bytes: 16777216,
          max_promoted_duration_seconds: 900,
        } } : { schema_version: 1, enabled: false, fresh_until: new Date(Date.now() + policyFreshMs).toISOString() }));
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", part => parts.push(Buffer.from(part)));
    request.on("end", () => {
      if (request.url === "/v1/rum/replay/chunks") {
        const wire = Buffer.concat(parts);
        wireBodies.push(wire);
        const body = (request.headers["content-encoding"] === "gzip" ? gunzipSync(wire) : wire).toString("utf8");
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
test.beforeEach(() => { releaseHeldReplayResponses(); bodies.length = 0; wireBodies.length = 0; policyRequests.length = 0; enabled = true; exposeDate = true; policyFreshMs = 12_000; maxChunks = 64; maxWire = 262144; maxDecoded = 1048576; replayStatuses = []; duplicateNext = false; holdReplay = false; enforceIngestDepth = false; });

test("gzip admits a snapshot larger than the wire cap while preserving the decoded cap", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(()=>{for(let i=0;i<1800;i++){const item=document.createElement("div");item.textContent="masked fixture";document.body.append(item);}});
  await page.evaluate(origin=>window.replayFixture.init(origin),ingestOrigin);
  await expect.poll(()=>page.evaluate(()=>window.replayFixture.status())).toBe("buffering");
  await page.evaluate(()=>window.replayFixture.trigger());
  await expect.poll(()=>bodies.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(bodies[0]!)).toBeGreaterThan(262144);
  expect(Buffer.byteLength(bodies[0]!)).toBeLessThan(1048576);
  expect(wireBodies[0]!.byteLength).toBeLessThan(262144);
});

test("compressed and decoded policy limits stop upload locally", async ({ page }) => {
  maxWire=1024;
  await page.goto(appOrigin);
  await page.evaluate(()=>{for(let i=0;i<80;i++){const item=document.createElement("div");item.className=Array.from(crypto.getRandomValues(new Uint8Array(128)),value=>value.toString(16).padStart(2,"0")).join("");document.body.append(item);}});
  await page.evaluate(({endpoint,origin})=>window.replayFixture.init(endpoint,true,[origin]),{endpoint:ingestOrigin,origin:appOrigin});
  await expect.poll(()=>page.evaluate(()=>window.replayFixture.status())).toBe("buffering");
  await page.evaluate(()=>window.replayFixture.trigger());
  await expect.poll(()=>page.evaluate(()=>window.replayFixture.status())).toBe("limit-reached");
  expect(bodies).toHaveLength(0);
  maxWire=1024;maxDecoded=1024;
  await page.reload();
  await page.evaluate(origin=>window.replayFixture.init(origin),ingestOrigin);
  await expect.poll(()=>page.evaluate(()=>window.replayFixture.status())).toBe("limit-reached");
  expect(bodies).toHaveLength(0);
});

test("identity fallback remains available without CompressionStream", async ({ page }) => {
  await page.addInitScript(()=>{Object.defineProperty(window,"CompressionStream",{value:undefined});});
  await page.goto(appOrigin);
  await page.evaluate(origin=>window.replayFixture.init(origin),ingestOrigin);
  await expect.poll(()=>page.evaluate(()=>window.replayFixture.status())).toBe("buffering");
  await page.evaluate(()=>window.replayFixture.trigger());
  await expect.poll(()=>bodies.length).toBeGreaterThan(0);
  expect(wireBodies[0]![0]).toBe(0x7b);
});

test("visual replay captures CSS, public assets, safe text and stylesheet changes before gzip upload", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(async () => {
    const link=document.createElement("link");link.rel="stylesheet";link.href="/visual.css";
    const loaded=new Promise<void>(resolve=>{link.onload=()=>resolve();});document.head.append(link);await loaded;
    const main=document.createElement("main");main.className="visual-grid";
    main.innerHTML='<span class="public-label">Public heading</span><span data-sentinel-mask>masked-secret</span><img src="/public.svg"><div style="height:1000px;grid-column:1/-1"></div><section id="after-scroll"></section><input value="visual-input-secret"><section data-sentinel-private><img src="/private.svg"><span>visual-private-secret</span></section>';
    document.body.append(main);
  });
  await page.evaluate(({endpoint,origin})=>window.replayFixture.init(endpoint,true,[origin]),{endpoint:ingestOrigin,origin:appOrigin});
  await expect.poll(()=>page.evaluate(()=>window.replayFixture.status())).toBe("buffering");
  await page.evaluate(()=>window.replayFixture.trigger());
  await expect.poll(()=>bodies.length).toBeGreaterThan(0);
  const first=JSON.parse(bodies[0]!) as {events:unknown[]};
  expect(bodies[0]).toContain("Public heading");
  expect(bodies[0]).toContain("grid-template-columns");
  expect(bodies[0]).toContain("/public.svg");
  expect(bodies[0]).toContain("/public.ttf");
  expect(bodies.join(" ")).not.toMatch(/masked-secret|visual-input-secret|visual-private-secret|private.svg|css-content-secret|css-sheet-secret/);
  expect(wireBodies.at(-1)![0]).toBe(0x1f);
  expect(wireBodies.at(-1)![1]).toBe(0x8b);
  await mkdir(test.info().outputDir,{recursive:true});
  await writeFile(test.info().outputPath("visual-events.json"),JSON.stringify(first.events));
  await page.evaluate(()=>{const sheet=document.querySelector<HTMLLinkElement>('link[href="/visual.css"]')!.sheet!;sheet.insertRule('.visual-grid{border:7px solid red}',sheet.cssRules.length);});
  await expect.poll(()=>bodies.some(body=>body.includes('7px solid red')),{timeout:5000}).toBe(true);
  await page.evaluate(() => {
    window.addEventListener("scroll", () => {
      document.querySelector("#after-scroll")!.innerHTML = '<h2>Visible after scroll</h2><img src="/public.svg">';
    }, { once: true });
    window.scrollTo(0, 800);
  });
  await expect.poll(() => bodies.some(body => body.includes("Visible after scroll")), { timeout: 5000 }).toBe(true);
  await writeFile(test.info().outputPath("visual-events.json"),JSON.stringify(bodies.flatMap(body=>(JSON.parse(body) as {events:unknown[]}).events)));
});

test("mobile named grid areas preserve cart text and numeric placement in captured CSS", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 739 });
  await page.goto(appOrigin);
  await page.evaluate(() => {
    document.body.replaceChildren();
    const style = document.createElement("style");
    style.textContent = 'body{margin:0;font:16px system-ui}.cart-row{display:grid;width:358px;margin:16px;gap:12px;grid-template-columns:1fr 170px 130px}.cart-desc{display:flex;flex-direction:column}.cart-name{margin:0}.cart-qty{display:flex;gap:12px}.cart-amount{text-align:right}@media(max-width:520px){.cart-row{grid-template-columns:1fr max-content;grid-template-areas:"desc remove" "qty amount"}.cart-desc{grid-area:desc}.cart-qty{grid-area:qty}.cart-amount{grid-area:amount}}';
    document.head.append(style);
    const row = document.createElement("section"); row.className = "cart-row";
    row.innerHTML = '<div class="cart-desc"><p class="cart-name">Picada Oferta</p><span>$ 11.500,00 kg</span></div><div class="cart-qty"><button>−</button><span>2.0kg</span><button>+</button></div><div class="cart-amount">$ 23.000,00</div>';
    document.body.append(row);
  });
  await page.evaluate(({ endpoint, origin }) => window.replayFixture.init(endpoint, true, [origin]), { endpoint: ingestOrigin, origin: appOrigin });
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  expect(bodies[0]).toContain('grid-template-areas');
  expect(bodies[0]).toContain('qty amount');
  const geometry = await page.locator('.cart-row').evaluate(row => {
    const rect = (selector: string) => { const r = row.querySelector(selector)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    return { desc: rect('.cart-desc'), qty: rect('.cart-qty'), amount: rect('.cart-amount') };
  });
  expect(geometry.desc.bottom).toBeLessThan(geometry.qty.top);
  expect(geometry.qty.right).toBeLessThanOrEqual(geometry.amount.left);
  await mkdir(test.info().outputDir, { recursive: true });
  await writeFile(test.info().outputPath("cart-grid-events.json"), JSON.stringify(bodies.flatMap(body => (JSON.parse(body) as { events: unknown[] }).events)));
});

test("visible text and approved lazy images survive scroll while control values stay excluded", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(() => {
    const main = document.createElement("main");
    main.innerHTML = '<h1>Catálogo público</h1><div style="height:1800px"></div><section id="lazy"></section><input value="typed-input-secret"><textarea>typed-textarea-secret</textarea><select><option>selected-secret</option></select><div contenteditable>editable-value-secret</div>';
    document.body.append(main);
    window.addEventListener("scroll", () => {
      const lazy = document.querySelector("#lazy")!;
      if (lazy.childNodes.length) return;
      lazy.innerHTML = '<h2>Producto después del scroll</h2><img src="/public.svg">';
      document.querySelector("h1")!.textContent = "Catálogo actualizado";
      document.querySelector("input")!.value = "updated-input-secret";
      document.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true }));
    }, { once: true });
  });
  await page.evaluate(({endpoint, origin}) => window.replayFixture.init(endpoint, true, [origin]), { endpoint: ingestOrigin, origin: appOrigin });
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.scrollTo(0, 1400));
  await expect(page.locator("#lazy h2")).toHaveText("Producto después del scroll");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  const output = bodies.join(" ");
  expect(output).toContain("Catálogo público");
  expect(output).toContain("Catálogo actualizado");
  expect(output).toContain("Producto después del scroll");
  expect(output).toContain("/public.svg");
  expect(output).not.toMatch(/typed-input-secret|updated-input-secret|typed-textarea-secret|selected-secret|editable-value-secret/);
  const events = bodies.flatMap(body => (JSON.parse(body) as { events: { type: number; data: { source?: number; y?: number } }[] }).events);
  expect(events.some(event => event.type === 3 && event.data.source === 3 && event.data.y! > 0)).toBe(true);
});

test("explicit full masking still excludes initial and updated page text", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(origin => window.replayFixture.init(origin, true, undefined, "*"), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.mutate());
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  expect(bodies.join(" ")).not.toMatch(/static-secret-text|dynamic-secret-text|input-secret|private-secret-text/);
});

test("uploaded snapshot preserves visible text and reconstructs resolved page layout without CSS resource requests", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = 'main {display:flex;width:640px;height:120px;background:rgb(12,34,56);padding:16px} main::before{content:"generated-secret"}';
    document.head.append(style);
    const main = document.createElement("main");
    main.textContent = "visible-secret";
    document.body.append(main);
  });
  await page.evaluate(origin => window.replayFixture.init(origin), ingestOrigin);
  await expect.poll(() => page.evaluate(() => window.replayFixture.status())).toBe("buffering");
  await page.evaluate(() => window.replayFixture.trigger());
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  const first = JSON.parse(bodies[0]!) as { events: unknown[] };
  const result = await page.evaluate(events => window.replayFixture.reconstructLayout(events), first.events);
  expect(result).toEqual({ background: "rgb(12, 34, 56)", display: "flex", width: "640px", text: "visible-secret" });
  expect(bodies.join(" ")).not.toMatch(/generated-secret|css-secret|attribute-secret|url-secret|css-sheet-secret/);
  await mkdir(test.info().outputDir, { recursive: true });
  await writeFile(test.info().outputPath("layout-events.json"), JSON.stringify(first.events));
  await page.evaluate(() => { document.querySelector("main")!.style.backgroundColor = "rgb(65, 43, 21)"; });
  await expect.poll(() => windowlessBodiesContain("background-color:rgb(65, 43, 21)"), { timeout: 5000 }).toBe(true);
});

function windowlessBodiesContain(value: string): boolean { return bodies.some(body => body.includes(value)); }

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
  expect(Buffer.byteLength(bodies[0]!)).toBeLessThan(262144);
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
  expect(bodies.join(" ")).toContain("static-secret-text");
  expect(bodies.join(" ")).toContain("dynamic-secret-text");
  expect(bodies.join(" ")).not.toMatch(/private-secret-text|dynamic-private-secret|input-secret|textarea-secret|select-secret|editable-secret|attribute-secret|css-secret|url-secret|image-secret|canvas-secret|media-secret|shadow-secret|cookie-secret|local-storage-secret|session-storage-secret|css-sheet-secret|script-secret|auth-header-secret|request-body-secret/);
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
  expect(wireBodies[1]).toEqual(wireBodies[0]);
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
    expect(bodies.join(" ")).toContain("heavy-secret");
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
  expect(bodies.join(" ").includes("dom-heavy-secret")).toBe(true);
});
