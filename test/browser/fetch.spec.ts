import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

interface HttpCapture {
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

const here = dirname(fileURLToPath(import.meta.url));
let appServer: Server;
let collectorServer: Server;
let allowedServer: Server;
let deniedServer: Server;
let appOrigin: string;
let collectorOrigin: string;
let allowedOrigin: string;
let deniedOrigin: string;
let appRequests: HttpCapture[];
let collectorRequests: HttpCapture[];
let allowedRequests: HttpCapture[];
let deniedRequests: HttpCapture[];

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function captureRequest(
  target: HttpCapture[],
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    target.push({
      url: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.setHeader("access-control-allow-origin", "*");
    response.end("ok");
  });
}

function captureCorsRequest(
  target: HttpCapture[],
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "traceparent,tracestate");
  response.setHeader("access-control-allow-methods", "GET,OPTIONS");
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  captureRequest(target, request, response);
}

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [resolve(here, "fixture.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    write: false,
  });

  appRequests = [];
  collectorRequests = [];
  allowedRequests = [];
  deniedRequests = [];
  const fixtureBundle = bundle.outputFiles[0]?.contents;
  if (!fixtureBundle) throw new Error("Missing browser fixture bundle");

  appServer = createServer((request, response) => {
    if (request.url?.startsWith("/network-fail")) { request.socket.destroy(); return; }
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><script src="/fixture.js"></script>');
      return;
    }
    if (request.url === "/fixture.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(fixtureBundle);
      return;
    }
    if (request.url?.startsWith("/server-error")) response.statusCode = 503;
    captureRequest(appRequests, request, response);
  });
  collectorServer = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader(
      "access-control-allow-headers",
      "authorization,content-type",
    );
    response.setHeader("access-control-allow-methods", "POST,OPTIONS");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    captureRequest(collectorRequests, request, response);
  });
  allowedServer = createServer((request, response) =>
    captureCorsRequest(allowedRequests, request, response),
  );
  deniedServer = createServer((request, response) =>
    captureCorsRequest(deniedRequests, request, response),
  );

  [appOrigin, collectorOrigin, allowedOrigin, deniedOrigin] = await Promise.all([
    listen(appServer),
    listen(collectorServer),
    listen(allowedServer),
    listen(deniedServer),
  ]);
});

test("opt-in RUM emits closed, private semantic batches", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    history.pushState({}, "", "/products?token=secret#fragment");
    history.replaceState({}, "", "/products?token=other#fragment");
    const input = document.createElement("input");
    input.value = "password-secret@example.com";
    document.body.append(input);
    const button = document.createElement("button");
    button.setAttribute("data-testid", "checkout");
    button.textContent = "password-secret@example.com";
    button.style.position = "fixed";
    button.style.top = "20px";
    button.style.left = "20px";
    document.body.append(button);
    const filler = document.createElement("div");
    filler.style.height = "3000px";
    document.body.append(filler);
  });
  for (let index = 0; index < 3; index++) await page.getByTestId("checkout").click();
  await page.waitForTimeout(900);
  await page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    window.sentinelFixture.dispatchError("https://example.com/path?token=secret#fragment");
    await fetch("/server-error?token=secret#fragment");
    try { await fetch("/network-fail?token=secret#fragment"); } catch { /* Expected. */ }
  });
  await page.evaluate(() => window.sentinelFixture.flush());
  const batches = collectorRequests.filter(request => request.url === "/v1/rum/events");
  expect(batches.length).toBeGreaterThan(0);
  const events = batches.flatMap(request => (JSON.parse(request.body) as { events: Array<Record<string, unknown>> }).events);
  const types = new Set(events.map(event => event.type));
  for (const type of ["page_view", "click", "rage_click", "dead_click", "scroll_depth", "javascript_error", "network_error"]) expect(types.has(type), `missing ${type}; got ${Array.from(types).join(",")}`).toBe(true);
  const allowedKeys = new Set(["id", "type", "timestamp", "route", "release", "trace_id", "span_id", "viewport", "position", "target", "data"]);
  for (const event of events) {
    expect(Object.keys(event).every(key => allowedKeys.has(key))).toBe(true);
    expect(event.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(event.timestamp).toMatch(/^20\d\d-\d\d-\d\dT/);
    expect(event.route).toMatch(/^\/[A-Za-z0-9/_~.-]*$/);
    if (!["click", "rage_click", "dead_click"].includes(String(event.type))) {
      expect(event.position).toBeUndefined();
      expect(event.target).toBeUndefined();
    }
  }
  expect(events.filter(event => event.type === "page_view").map(event => event.route)).toEqual(["/", "/products"]);
  for (const request of batches) {
    expect(request.headers.authorization).toMatch(/^Bearer sip_pub_/);
    expect(request.headers["content-type"]).toContain("application/json");
    expect(request.body).not.toMatch(/password-secret|token=secret|#fragment|tenant_id|application_id|environment_id|credential_id/);
  }
  const network = events.filter(event => event.type === "network_error");
  expect(network.map(event => (event.data as Record<string, unknown>).status_code).sort()).toEqual([503, undefined].sort());
  expect(collectorRequests.some(request => request.url === "/v1/logs")).toBe(true);
  for (const event of events.filter(event => ["click", "rage_click", "dead_click"].includes(String(event.type)))) {
    const position = event.position as Record<string, number>;
    expect(Object.values(position)).toHaveLength(4);
    for (const value of Object.values(position)) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of Object.values(position)) expect(value).toBeLessThanOrEqual(1);
    expect(Object.keys(event.target as object).length).toBeGreaterThan(0);
  }
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM automatically identifies small controls and shares target privacy across click, rage and dead events", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    const button = (id: string, text: string) => {
      const node = document.createElement("button");
      node.setAttribute("data-testid", id);
      node.textContent = text;
      document.body.append(node);
      return node;
    };
    const click = (node: Element) => node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 20, clientY: 20 }));
    click(button("ordinary", "  Finalizar   compra  "));
    const labelled = button("aria", "Ignored text");
    labelled.setAttribute("aria-label", "  Confirmar   compra ");
    click(labelled);
    const svgButton = button("svg", "Finalizar compra");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.append(path);
    svgButton.prepend(svg);
    click(path);
    const nestedButton = button("outer", "");
    const nestedSpan = document.createElement("span");
    nestedSpan.setAttribute("data-testid", "inner");
    nestedSpan.textContent = "Pagar ahora";
    nestedButton.append(nestedSpan);
    click(nestedSpan);
    const privateButton = button("private-control", "Secret account name");
    privateButton.setAttribute("data-sentinel-private", "");
    privateButton.setAttribute("aria-label", "Secret account label");
    click(privateButton);
    const parent = document.createElement("div");
    parent.setAttribute("data-sentinel-private", "");
    const privateChild = button("private-parent", "Private child text");
    parent.append(privateChild);
    document.body.append(parent);
    click(privateChild);
    const rage = button("rage-shared", "Finalizar compra");
    for (let i = 0; i < 3; i++) click(rage);
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.sentinelFixture.flush());
  const events = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; target?: { tag?: string; test_id?: string; label?: string; text?: string } }> }).events);
  const byId = (id: string) => events.filter(event => event.target?.test_id === id);
  expect(byId("ordinary").find(event => event.type === "click")?.target).toEqual({ tag: "button", role: "button", test_id: "ordinary", text: "Finalizar compra" });
  expect(byId("aria").find(event => event.type === "click")?.target).toEqual({ tag: "button", role: "button", test_id: "aria", label: "Confirmar compra" });
  expect(byId("svg").find(event => event.type === "click")?.target).toEqual({ tag: "button", role: "button", test_id: "svg", text: "Finalizar compra" });
  expect(byId("outer").find(event => event.type === "click")?.target).toEqual({ tag: "button", role: "button", test_id: "outer", text: "Pagar ahora" });
  expect(byId("inner")).toHaveLength(0);
  for (const id of ["private-control", "private-parent"]) {
    expect(byId(id).some(event => event.type === "click")).toBe(true);
    expect(byId(id).every(event => event.target?.label === undefined && event.target?.text === undefined)).toBe(true);
  }
  for (const type of ["click", "rage_click", "dead_click"]) {
    const samples = byId("rage-shared").filter(event => event.type === type);
    expect(samples.length, `missing ${type}`).toBeGreaterThan(0);
    expect(samples.every(event => event.target?.text === "Finalizar compra" && event.target?.label === undefined)).toBe(true);
  }
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM records real pointer attempts on enabled and disabled buttons", async ({ page }, testInfo) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    const observed: Array<{ type: string; target: string; trusted: boolean }> = [];
    (window as unknown as { rumAttemptEvents: typeof observed }).rumAttemptEvents = observed;
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
      document.addEventListener(type, event => {
        const target = event.target;
        observed.push({ type, target: target instanceof Element ? target.closest("button")?.getAttribute("data-testid") ?? target.tagName.toLowerCase() : "other", trusted: event.isTrusted });
      }, true);
    }
    const fixtures = [
      { id: "enabled-direct", disabled: false, wrapped: false },
      { id: "enabled-span", disabled: false, wrapped: true },
      { id: "disabled-direct", disabled: true, wrapped: false },
      { id: "disabled-span", disabled: true, wrapped: true },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const button = document.createElement("button");
      button.setAttribute("data-testid", fixture.id);
      button.disabled = fixture.disabled;
      button.style.cssText = `position:fixed;left:${20 + index * 160}px;top:100px;width:150px;height:60px;`;
      if (fixture.wrapped) {
        const span = document.createElement("span");
        span.textContent = "Confirmar compra";
        button.append(span);
      } else button.textContent = "Confirmar compra";
      document.body.append(button);
    }
  });
  const fixtures = ["enabled-direct", "enabled-span", "disabled-direct", "disabled-span"];
  for (const id of fixtures) {
    const box = await page.locator(`[data-testid="${id}"]`).boundingBox();
    expect(box).not.toBeNull();
    for (let i = 0; i < 3; i++) await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForTimeout(1_100);
  }
  await page.evaluate(() => window.sentinelFixture.flush());
  const raw = await page.evaluate(() => (window as unknown as { rumAttemptEvents: Array<{ type: string; target: string; trusted: boolean }> }).rumAttemptEvents);
  const emitted = collectorRequests.filter(request => request.url === "/v1/rum/events")
    .flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; target?: { test_id?: string; tag?: string; role?: string; text?: string } }> }).events)
    .filter(event => fixtures.includes(event.target?.test_id ?? ""))
    .map(event => ({ type: event.type, target: event.target }));
  const summary: Record<string, { raw: string[]; rum: string[] }> = Object.fromEntries(fixtures.map(id => [id, {
    raw: raw.filter(event => event.target === id).map(event => event.type),
    rum: emitted.filter(event => event.target?.test_id === id).map(event => event.type),
  }]));
  console.log(`${testInfo.project.name} disabled-control audit: ${JSON.stringify(summary)}`);
  expect(raw.every(event => event.trusted)).toBe(true);
  for (const id of fixtures) {
    const actual = summary[id];
    expect(actual?.raw.filter(type => type === "pointerdown")).toHaveLength(3);
    expect(actual?.raw.filter(type => type === "pointerup")).toHaveLength(3);
    if (id.startsWith("disabled")) {
      expect(actual?.raw.filter(type => ["mousedown", "mouseup", "click"].includes(type))).toHaveLength(0);
      expect(actual?.rum).toHaveLength(0);
    } else {
      expect(actual?.raw.filter(type => type === "click")).toHaveLength(3);
      expect(actual?.rum.filter(type => type === "click")).toHaveLength(3);
      expect(actual?.rum.filter(type => type === "rage_click")).toHaveLength(1);
      expect(emitted.filter(event => event.target?.test_id === id).every(event => event.target?.text === "Confirmar compra")).toBe(true);
      expect(emitted.filter(event => event.target?.test_id === id).every(event => event.target?.tag === "button" && event.target?.role === "button")).toBe(true);
    }
  }
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM omits sensitive values, arbitrary containers and oversized subtrees", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    const click = (node: Element) => node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 20, clientY: 20 }));
    const field = (tag: "input" | "textarea" | "select", id: string) => {
      const node = document.createElement(tag);
      node.setAttribute("data-testid", id);
      node.setAttribute("aria-label", "Sensitive label");
      document.body.append(node);
      return node;
    };
    const input = field("input", "input"); input.value = "input-secret"; click(input);
    const password = field("input", "password") as HTMLInputElement; password.type = "password"; password.value = "password-secret"; click(password);
    const textarea = field("textarea", "textarea"); textarea.value = "textarea-secret"; click(textarea);
    const select = field("select", "select");
    const option = document.createElement("option"); option.value = "select-secret"; option.textContent = "select-secret"; select.append(option); select.value = "select-secret"; click(select);
    const editable = document.createElement("div"); editable.contentEditable = "true"; editable.setAttribute("role", "button"); editable.setAttribute("data-testid", "editable"); editable.textContent = "editable-secret"; editable.setAttribute("aria-label", "Sensitive label"); document.body.append(editable); click(editable);
    const container = document.createElement("div"); container.setAttribute("data-testid", "container"); container.textContent = "arbitrary private page text"; document.body.append(container); click(container);
    const oversized = document.createElement("button"); oversized.setAttribute("data-testid", "oversized");
    for (let i = 0; i < 13; i++) { const span = document.createElement("span"); span.textContent = "Safe"; oversized.append(span); }
    document.body.append(oversized); click(oversized);
    const hugeText = document.createElement("button"); hugeText.setAttribute("data-testid", "huge-text"); hugeText.textContent = "A".repeat(200_000); document.body.append(hugeText); click(hugeText);
    const nested = document.createElement("button"); nested.setAttribute("data-testid", "nested-subtree");
    const outer = document.createElement("span"); const inner = document.createElement("span"); inner.textContent = "Hidden sensitive state"; outer.append(inner); nested.append(outer); document.body.append(nested); click(nested);
    const hidden = document.createElement("button"); hidden.setAttribute("data-testid", "hidden-text");
    const hiddenSpan = document.createElement("span"); hiddenSpan.hidden = true; hiddenSpan.textContent = "Hidden sensitive state"; hidden.append(hiddenSpan); document.body.append(hidden); click(hidden);
    const privateInline = document.createElement("button"); privateInline.setAttribute("data-testid", "private-inline");
    const privateSpan = document.createElement("span"); privateSpan.setAttribute("data-sentinel-private", ""); privateSpan.textContent = "Private child text";
    privateInline.append(privateSpan); document.body.append(privateInline); click(privateInline);
    const longLabel = document.createElement("button"); longLabel.setAttribute("data-testid", "long-label"); longLabel.setAttribute("aria-label", "A".repeat(81)); document.body.append(longLabel); click(longLabel);
    const longUnicode = document.createElement("button"); longUnicode.setAttribute("data-testid", "long-unicode"); longUnicode.setAttribute("aria-label", "é".repeat(41)); document.body.append(longUnicode); click(longUnicode);
    const maxLabel = document.createElement("button"); maxLabel.setAttribute("data-testid", "max-label"); maxLabel.setAttribute("aria-label", "A".repeat(80)); document.body.append(maxLabel); click(maxLabel);
    const longTestId = document.createElement("button"); longTestId.setAttribute("data-testid", "x".repeat(129)); longTestId.setAttribute("aria-label", "Bounded identifier"); document.body.append(longTestId); click(longTestId);
  });
  await page.evaluate(() => window.sentinelFixture.flush());
  const batches = collectorRequests.filter(request => request.url === "/v1/rum/events");
  const events = batches.flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; target?: { test_id?: string; label?: string; text?: string } }> }).events);
  for (const id of ["input", "password", "textarea", "select", "editable", "container", "oversized", "huge-text", "nested-subtree", "hidden-text", "private-inline", "long-label", "long-unicode"]) {
    const target = events.find(event => event.type === "click" && event.target?.test_id === id)?.target;
    expect(target, `missing ${id}`).toBeDefined();
    expect(target?.label, id).toBeUndefined();
    expect(target?.text, id).toBeUndefined();
  }
  expect(events.find(event => event.type === "click" && event.target?.test_id === "max-label")?.target?.label).toBe("A".repeat(80));
  expect(events.find(event => event.type === "click" && event.target?.label === "Bounded identifier")?.target?.test_id).toBeUndefined();
  const bodies = batches.map(batch => batch.body).join("\n");
  for (const secret of ["input-secret", "password-secret", "textarea-secret", "select-secret", "editable-secret", "arbitrary private page text", "Hidden sensitive state", "Private child text", "Sensitive label"]) expect(bodies).not.toContain(secret);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("private subtree suppression persists in rage and dead click emissions", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    const parent = document.createElement("div");
    parent.setAttribute("data-sentinel-private", "");
    const button = document.createElement("button");
    button.setAttribute("data-testid", "private-rage");
    button.setAttribute("aria-label", "Sensitive account label");
    button.textContent = "Sensitive account text";
    parent.append(button);
    document.body.append(parent);
    for (let i = 0; i < 3; i++) button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 20, clientY: 20 }));
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.sentinelFixture.flush());
  const batches = collectorRequests.filter(request => request.url === "/v1/rum/events");
  const events = batches.flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; target?: { tag?: string; test_id?: string; label?: string; text?: string } }> }).events)
    .filter(event => event.target?.test_id === "private-rage");
  for (const type of ["click", "rage_click", "dead_click"]) {
    expect(events.some(event => event.type === type), `missing ${type}`).toBe(true);
  }
  expect(events.every(event => event.target?.tag === "button" && event.target?.label === undefined && event.target?.text === undefined)).toBe(true);
  expect(batches.map(batch => batch.body).join("\n")).not.toContain("Sensitive account");
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM dead-click candidates are cancelled by observable responses", async ({ page }) => {
  await page.clock.install();
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(async () => {
    const button = document.createElement("button");
    button.setAttribute("data-testid", "response-button");
    document.body.append(button);
    const click = () => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 20, clientY: 20 }));
    click();
    document.body.append(document.createElement("span"));
    await new Promise(resolve => setTimeout(resolve, 20));
    click();
    document.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    click();
    history.pushState({}, "", "/response");
    click();
    await fetch("/ok");
  });
  await page.clock.runFor(701);
  await page.evaluate(() => window.sentinelFixture.flushNow());
  const events = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string }> }).events);
  expect(events.filter(event => event.type === "click")).toHaveLength(4);
  expect(events.some(event => event.type === "dead_click")).toBe(false);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("fetch started before a click cannot cancel its later dead-click candidate", async ({ page }) => {
  await page.clock.install();
  await page.goto(appOrigin);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/slow-before", async route => {
    await held;
    await route.fulfill({ status: 200, body: "ok" });
  });
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.setAttribute("data-testid", "after-fetch");
    document.body.append(button);
    void fetch("/slow-before");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 20, clientY: 20 }));
  });
  expect(await page.evaluate(() => window.sentinelFixture.rumPendingState().count)).toBe(1);
  const response = page.waitForResponse("**/slow-before");
  release();
  await response;
  await page.clock.runFor(701);
  await page.evaluate(() => window.sentinelFixture.flushNow());
  const events = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; target?: { test_id?: string } }> }).events);
  expect(events.filter(event => event.type === "dead_click").map(event => event.target?.test_id)).toEqual(["after-fetch"]);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("fetch start cancels existing candidates while its later response leaves newer candidates alone", async ({ page }) => {
  await page.clock.install();
  await page.goto(appOrigin);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/slow-after", async route => {
    await held;
    await route.fulfill({ status: 200, body: "ok" });
  });
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    for (const name of ["first", "second", "third", "fourth"]) {
      const button = document.createElement("button");
      button.setAttribute("data-testid", name);
      document.body.append(button);
    }
    for (const name of ["first", "second"]) document.querySelector(`[data-testid='${name}']`)?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 20, clientY: 20 }));
  });
  expect(await page.evaluate(() => window.sentinelFixture.rumPendingState().count)).toBe(2);
  await page.clock.runFor(100);
  await page.evaluate(() => {
    void fetch("/slow-after");
    for (const name of ["third", "fourth"]) document.querySelector(`[data-testid='${name}']`)?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 20, clientY: 20 }));
  });
  expect(await page.evaluate(() => window.sentinelFixture.rumPendingState().count)).toBe(2);
  const response = page.waitForResponse("**/slow-after");
  await page.clock.runFor(200);
  release();
  await response;
  expect(await page.evaluate(() => window.sentinelFixture.rumPendingState().count)).toBe(2);
  await page.clock.runFor(501);
  await page.evaluate(() => window.sentinelFixture.flushNow());
  const events = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; target?: { test_id?: string } }> }).events);
  expect(events.filter(event => event.type === "dead_click").map(event => event.target?.test_id)).toEqual(["third", "fourth"]);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("dead-click candidates stay capped at 16 and shutdown clears timers and observer", async ({ page }) => {
  await page.clock.install();
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    const buttons: HTMLButtonElement[] = [];
    for (let index = 0; index < 17; index++) {
      const button = document.createElement("button");
      button.setAttribute("data-testid", `bounded-${index}`);
      document.body.append(button);
      buttons.push(button);
    }
    for (const button of buttons) button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 20, clientY: 20 }));
  });
  expect(await page.evaluate(() => window.sentinelFixture.rumPendingState())).toEqual({ count: 16, observing: true });
  expect(await page.evaluate(() => window.sentinelFixture.shutdownWithPendingState())).toEqual({ count: 0, observing: false });
  await page.clock.runFor(701);
  const events = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string }> }).events);
  expect(events.some(event => event.type === "dead_click")).toBe(false);
});

test("RUM session survives reload and route history does not duplicate views", async ({ page, context }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  const first = await page.evaluate(() => JSON.parse(sessionStorage.getItem("@unkcode/sentinel/rum-session-v1") ?? "null") as { id: string });
  await page.evaluate(async () => {
    history.pushState({}, "", "/one?token=secret");
    history.replaceState({}, "", "/one#secret");
    history.pushState({}, "", "/two");
    history.back();
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.sentinelFixture.flush();
    await window.sentinelFixture.shutdown();
  });
  const beforeReload = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; route: string }> }).events);
  expect(beforeReload.filter(event => event.type === "page_view").map(event => event.route)).toEqual(["/", "/one", "/two", "/one"]);
  await page.evaluate(() => history.replaceState({}, "", "/"));
  await page.reload();
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  const second = await page.evaluate(() => JSON.parse(sessionStorage.getItem("@unkcode/sentinel/rum-session-v1") ?? "null") as { id: string });
  expect(second.id).toBe(first.id);
  await page.evaluate(() => window.sentinelFixture.shutdown());
  const otherTab = await context.newPage();
  await otherTab.goto(appOrigin);
  await otherTab.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  const other = await otherTab.evaluate(() => JSON.parse(sessionStorage.getItem("@unkcode/sentinel/rum-session-v1") ?? "null") as { id: string });
  expect(other.id).not.toBe(first.id);
  await otherTab.evaluate(() => window.sentinelFixture.shutdown());
  await otherTab.close();
  await page.evaluate(id => sessionStorage.setItem("@unkcode/sentinel/rum-session-v1", JSON.stringify({ id, at: Date.now() - 31 * 60_000 })), first.id);
  await page.reload();
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  const rotated = await page.evaluate(() => JSON.parse(sessionStorage.getItem("@unkcode/sentinel/rum-session-v1") ?? "null") as { id: string });
  expect(rotated.id).not.toBe(first.id);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM batches at 20 events and retries one transient failure", async ({ page }) => {
  const sent: string[] = [];
  await page.route("**/v1/rum/events", async route => {
    sent.push(route.request().postData() ?? "");
    await route.fulfill({ status: sent.length === 1 ? 503 : 202, contentType: "application/json", body: '{"accepted":20}' });
  });
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), appOrigin);
  await page.evaluate(() => {
    for (let index = 0; index < 19; index++) {
      const node = document.createElement("div");
      node.setAttribute("data-testid", `item-${index}`);
      document.body.append(node);
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20, detail: 1 }));
    }
  });
  await page.evaluate(() => window.sentinelFixture.flush());
  expect(sent).toHaveLength(2);
  expect(JSON.parse(sent[0]!) as { events: unknown[] }).toEqual(expect.objectContaining({ events: expect.any(Array) }));
  expect((JSON.parse(sent[0]!) as { events: unknown[] }).events).toHaveLength(20);
  expect(sent[1]).toBe(sent[0]);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM shutdown restores history and does not duplicate listeners", async ({ page }) => {
  await page.goto(appOrigin);
  const original = await page.evaluate(() => {
    (window as Window & { originalPush?: History["pushState"] }).originalPush = history.pushState;
    return history.pushState.toString();
  });
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => window.sentinelFixture.shutdown());
  expect(await page.evaluate(() => history.pushState.toString())).toBe(original);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    const node = document.createElement("div");
    document.body.append(node);
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 10, clientY: 10 }));
  });
  await page.evaluate(() => window.sentinelFixture.flush());
  const clicks = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string }> }).events).filter(event => event.type === "click");
  expect(clicks).toHaveLength(1);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM works when sessionStorage access is denied", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(() => {
    Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("storage denied"); } });
  });
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => window.sentinelFixture.flush());
  const batches = collectorRequests.filter(request => request.url === "/v1/rum/events");
  expect(batches).toHaveLength(1);
  expect((JSON.parse(batches[0]!.body) as { session_id: string }).session_id).toMatch(/^[a-f0-9]{32}$/);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM scroll milestones emit once per route and reset after navigation", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    const filler = document.createElement("div");
    filler.style.height = "5000px";
    document.body.append(filler);
    window.scrollTo(0, document.documentElement.scrollHeight);
    document.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(160);
  await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
  await page.waitForTimeout(160);
  await page.evaluate(() => {
    history.pushState({}, "", "/another-route");
    document.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(160);
  await page.evaluate(() => window.sentinelFixture.flush());
  const scrolls = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; route: string; data: { depth?: number } }> }).events).filter(event => event.type === "scroll_depth");
  for (const route of ["/", "/another-route"]) {
    expect(scrolls.filter(event => event.route === route).map(event => event.data.depth)).toEqual([0.25, 0.5, 0.75, 0.9, 1]);
  }
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM pagehide flush preserves Authorization and uses keepalive fetch", async ({ page }) => {
  await page.goto(appOrigin);
  const keepalive = await page.evaluate(async endpoint => {
    window.sentinelFixture.initRum(endpoint);
    const previous = window.fetch;
    let observed: boolean | undefined;
    window.fetch = (input, init) => {
      if (String(input) === `${endpoint}/v1/rum/events`) observed = init?.keepalive;
      return previous(input, init);
    };
    window.dispatchEvent(new Event("pagehide"));
    await new Promise(resolve => setTimeout(resolve, 200));
    window.fetch = previous;
    await window.sentinelFixture.shutdown();
    return observed;
  }, collectorOrigin);
  expect(keepalive).toBe(true);
  const request = collectorRequests.find(item => item.url === "/v1/rum/events");
  expect(request?.headers.authorization).toMatch(/^Bearer sip_pub_/);
});

test("RUM queue drops oldest events at its 200-event bound", async ({ page }) => {
  const sent: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/v1/rum/events", async route => {
    sent.push(route.request().postData() ?? "");
    if (sent.length === 1) await gate;
    await route.fulfill({ status: 202, contentType: "application/json", body: '{"accepted":20}' });
  });
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), appOrigin);
  await page.evaluate(() => {
    for (let index = 0; index < 249; index++) {
      const node = document.createElement("div");
      node.setAttribute("data-testid", `item-${index}`);
      document.body.append(node);
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 10, clientY: 10 }));
    }
  });
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  release?.();
  await page.evaluate(() => window.sentinelFixture.flush());
  const batches = sent.map(body => JSON.parse(body) as { events: Array<{ type: string; target?: { test_id?: string } }> });
  expect(batches.every(batch => batch.events.length <= 20)).toBe(true);
  expect(batches.reduce((sum, batch) => sum + batch.events.length, 0)).toBe(220);
  const ids = batches.flatMap(batch => batch.events.map(event => event.target?.test_id));
  expect(ids).toContain("item-0");
  expect(ids).not.toContain("item-19");
  expect(ids).toContain("item-248");
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM events correlate with an active OTel span", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => window.sentinelFixture.errorInsideSpan());
  await page.evaluate(() => window.sentinelFixture.flush());
  const events = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; trace_id?: string; span_id?: string }> }).events);
  const captured = events.find(event => event.type === "javascript_error");
  expect(captured?.trace_id).toMatch(/^[0-9a-f]{32}$/);
  expect(captured?.span_id).toMatch(/^[0-9a-f]{16}$/);
  expect(JSON.stringify(events)).not.toContain("secret@example.com");
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("automatic browser errors fan out exactly once for each configuration", async ({ page }) => {
  const modes = [
    { captureErrors: false, rum: false },
    { captureErrors: true, rum: false },
    { captureErrors: false, rum: true },
    { captureErrors: true, rum: true },
  ];
  for (const mode of modes) {
    collectorRequests.length = 0;
    await page.goto(appOrigin);
    const listeners = await page.evaluate(({ endpoint, captureErrors, rum }) => window.sentinelFixture.initErrorMode(endpoint, captureErrors, rum), { endpoint: collectorOrigin, captureErrors: mode.captureErrors, rum: mode.rum });
    const expectedListeners = mode.captureErrors || mode.rum ? 1 : 0;
    expect(listeners).toEqual({ error: expectedListeners, unhandledrejection: expectedListeners });
    await page.evaluate(async () => {
      window.sentinelFixture.dispatchError("https://example.com/app.js?token=secret");
      window.sentinelFixture.dispatchRejection();
      await window.sentinelFixture.flush();
    });
    const rumEvents = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string }> }).events);
    expect(rumEvents.filter(event => event.type === "javascript_error")).toHaveLength(mode.rum ? 2 : 0);
    const logCount = () => collectorRequests.filter(request => request.url === "/v1/logs").reduce((count, request) => {
      const payload = JSON.parse(request.body) as { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: unknown[] }> }> };
      return count + (payload.resourceLogs ?? []).flatMap(resource => resource.scopeLogs ?? []).flatMap(scope => scope.logRecords ?? []).length;
    }, 0);
    expect(logCount()).toBe(mode.captureErrors ? 2 : 0);
    await page.evaluate(async () => {
      window.sentinelFixture.manualException();
      await window.sentinelFixture.flush();
    });
    expect(logCount()).toBe(mode.captureErrors ? 3 : 1);
    const afterManual = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string }> }).events);
    expect(afterManual.filter(event => event.type === "javascript_error")).toHaveLength(mode.rum ? 2 : 0);
    await page.evaluate(() => window.sentinelFixture.shutdown());
  }
});

test("a browser TypeError rejection event reaches RUM and the existing OTel pipeline", async ({ page }) => {
  await page.goto(appOrigin);
  const listeners = await page.evaluate(endpoint => window.sentinelFixture.initErrorMode(endpoint, true, true), collectorOrigin);
  expect(listeners).toEqual({ error: 1, unhandledrejection: 1 });
  await page.evaluate(() => {
    window.sentinelFixture.dispatchTypedRejection();
    window.sentinelFixture.dispatchObjectRejection();
  });
  await page.evaluate(() => window.sentinelFixture.flush());
  const rumRequests = collectorRequests.filter(request => request.url === "/v1/rum/events");
  const events = rumRequests.flatMap(request => (JSON.parse(request.body) as { schema_version: number; events: Array<{ type: string; data?: Record<string, unknown> }> }).events);
  expect(rumRequests.every(request => (JSON.parse(request.body) as { schema_version: number }).schema_version === 1)).toBe(true);
  expect(events.filter(event => event.type === "javascript_error")).toEqual([
    expect.objectContaining({ type: "javascript_error", data: expect.objectContaining({ error_type: "TypeError", message: "RUM test rejection" }) }),
    expect.objectContaining({ type: "javascript_error", data: { error_type: "UnhandledRejection", message: "Unhandled promise rejection" } }),
  ]);
  expect(rumRequests.every(request => !request.body.includes("must-not-leak") && !request.body.includes('"private"'))).toBe(true);
  expect(collectorRequests.some(request => request.url === "/v1/logs" && request.body.includes("RUM test rejection"))).toBe(true);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("browser-provided error stacks reach RUM as safe frames without invented correlation", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initErrorMode(endpoint, false, true), collectorOrigin);
  await page.evaluate(() => {
    window.sentinelFixture.dispatchStackedErrors();
    window.sentinelFixture.dispatchObjectRejection();
  });
  await page.evaluate(() => window.sentinelFixture.flush());
  const events = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; data?: Record<string, unknown>; trace_id?: string; span_id?: string }> }).events).filter(event => event.type === "javascript_error");
  expect(events).toHaveLength(3);
  expect(events[0]?.data).toEqual({ error_type: "Error", message: "RUM window stack", stack: "at https://example.com/app.js:12:3" });
  expect(events[1]?.data).toEqual({ error_type: "TypeError", message: "RUM rejection stack", stack: "at https://example.com/chunk.mjs:45:6" });
  expect(events[2]?.data).toEqual({ error_type: "UnhandledRejection", message: "Unhandled promise rejection" });
  expect(events.every(event => event.trace_id === undefined && event.span_id === undefined)).toBe(true);
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("RUM rage clicks require three nearby clicks within one second", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.initRum(endpoint), collectorOrigin);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.setAttribute("data-testid", "rage-target");
    document.body.append(button);
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const click = (x: number) => button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: x, clientY: 30 }));
      click(20);
      now += 200; click(20);
      now += 1_001; click(20);
      now += 100; click(500);
      now += 100; click(20);
      now += 100; click(20);
    } finally { Date.now = realNow; }
  });
  await page.evaluate(() => window.sentinelFixture.flush());
  const events = collectorRequests.filter(request => request.url === "/v1/rum/events").flatMap(request => (JSON.parse(request.body) as { events: Array<{ type: string; data?: { click_count: number; duration_ms: number } }> }).events);
  const rage = events.filter(event => event.type === "rage_click");
  expect(rage).toHaveLength(1);
  expect(rage[0]?.data).toEqual({ click_count: 3, duration_ms: 300 });
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test.afterAll(async () => {
  await Promise.all([
    close(appServer),
    close(collectorServer),
    close(allowedServer),
    close(deniedServer),
  ]);
});

test.beforeEach(() => {
  appRequests.length = 0;
  collectorRequests.length = 0;
  allowedRequests.length = 0;
  deniedRequests.length = 0;
});

test("preserves pathnames, strips secrets, prevents recursion, and propagates W3C context", async ({
  page,
}) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.init(endpoint), collectorOrigin);
  await page.evaluate(async () => {
    const secretUrl = "/api/v2/comprobantes?token=secret#fragment";
    await window.sentinelFixture.fetchString(secretUrl);
    await window.sentinelFixture.fetchRequest(secretUrl);
    window.sentinelFixture.logUrl(
      "https://api.example.com/api/v2/comprobantes?token=secret#fragment",
    );
    await window.sentinelFixture.flush();
  });

  const traceExports = collectorRequests.filter(request =>
    request.url.endsWith("/v1/traces"),
  );
  expect(traceExports).toHaveLength(1);
  const payloadText = traceExports[0]?.body ?? "";
  expect(payloadText).toContain("/api/v2/comprobantes");
  expect(payloadText).not.toContain("token=secret");
  expect(payloadText).not.toContain("fragment");
  expect(payloadText).not.toContain("authorization");
  expect(payloadText).not.toContain("cookie");
  expect(payloadText).not.toContain(collectorOrigin);

  const payload = JSON.parse(payloadText) as {
    resourceSpans: Array<{
      scopeSpans: Array<{
        spans: Array<{
          name: string;
          traceId: string;
          spanId: string;
        }>;
      }>;
    }>;
  };
  const spans = payload.resourceSpans.flatMap(resource =>
    resource.scopeSpans.flatMap(scope => scope.spans),
  );
  expect(spans).toHaveLength(2);
  expect(spans.map(span => span.name)).toEqual([
    "GET /api/v2/comprobantes",
    "GET /api/v2/comprobantes",
  ]);
  const applicationFetches = appRequests.filter(request =>
    request.url.startsWith("/api/v2/comprobantes"),
  );
  expect(applicationFetches).toHaveLength(2);
  for (const request of applicationFetches) {
    const traceparent = request.headers.traceparent;
    expect(traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    );
    expect(Object.keys(request.headers)).not.toContain("x-sentinel-trace-id");
    const [, traceId, parentSpanId] = String(traceparent).split("-");
    expect(spans).toContainEqual(
      expect.objectContaining({ traceId, spanId: parentSpanId }),
    );
  }

  const hookDrafts = await page.evaluate(() => window.sentinelFixture.drafts);
  expect(JSON.stringify(hookDrafts)).not.toContain("token=secret");
  expect(JSON.stringify(hookDrafts)).not.toContain("fragment");
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("allows configured cross-origin propagation and denies other origins", async ({
  page,
}) => {
  await page.goto(appOrigin);
  await page.evaluate(
    ({ endpoint, target }) => window.sentinelFixture.init(endpoint, [target]),
    { endpoint: collectorOrigin, target: allowedOrigin },
  );
  await page.evaluate(
    async ({ allowed, denied }) => {
      await window.sentinelFixture.fetchString(`${allowed}/allowed`);
      await window.sentinelFixture.fetchString(`${denied}/denied`);
      await window.sentinelFixture.flush();
    },
    { allowed: allowedOrigin, denied: deniedOrigin },
  );

  expect(allowedRequests[0]?.headers.traceparent).toMatch(/^00-/);
  expect(deniedRequests[0]?.headers.traceparent).toBeUndefined();
  await page.evaluate(() => window.sentinelFixture.shutdown());
});

test("captures browser errors without exporting URL secrets", async ({ page }) => {
  await page.goto(appOrigin);
  await page.evaluate(endpoint => window.sentinelFixture.init(endpoint), collectorOrigin);
  await page.evaluate(async () => {
    window.sentinelFixture.dispatchError(
      "https://example.com/app.js?token=secret#fragment",
    );
    await window.sentinelFixture.flush();
  });

  const logPayload = collectorRequests.find(request =>
    request.url.endsWith("/v1/logs"),
  )?.body;
  expect(logPayload).toContain("https://example.com/app.js");
  expect(logPayload).not.toContain("token=secret");
  expect(logPayload).not.toContain("fragment");
  await page.evaluate(() => window.sentinelFixture.shutdown());
});
