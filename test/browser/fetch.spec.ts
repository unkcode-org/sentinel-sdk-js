import { readFile } from "node:fs/promises";
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
const bundlePath = resolve(here, ".generated/fixture.js");
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
    response.statusCode = 200;
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
  await build({
    entryPoints: [resolve(here, "fixture.ts")],
    outfile: bundlePath,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
  });

  appRequests = [];
  collectorRequests = [];
  allowedRequests = [];
  deniedRequests = [];
  const fixtureBundle = await readFile(bundlePath);

  appServer = createServer((request, response) => {
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
        spans: Array<{ traceId: string; spanId: string }>;
      }>;
    }>;
  };
  const spans = payload.resourceSpans.flatMap(resource =>
    resource.scopeSpans.flatMap(scope => scope.spans),
  );
  expect(spans).toHaveLength(2);
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
