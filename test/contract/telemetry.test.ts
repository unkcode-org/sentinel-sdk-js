import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { SeverityNumber } from "@opentelemetry/api-logs";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeConfig } from "../../src/config";
import { createTelemetry } from "../../src/telemetry";

interface ReceivedRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

describe("official OpenTelemetry pipelines", () => {
  const shutdowns: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.allSettled(shutdowns.splice(0).map(shutdown => shutdown()));
  });

  it("exports traces, logs, and metrics to their standard OTLP endpoints", async () => {
    const publicKey =
      "sip_pub_0000000000000000000000000000000000000000000";
    const received: ReceivedRequest[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks),
        });
        response.statusCode = 200;
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    shutdowns.push(
      () =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const port = (server.address() as AddressInfo).port;
    const config = normalizeConfig({
      endpoint: `http://127.0.0.1:${port}/otel`,
      publicKey,
      serviceName: "contract-frontend",
      release: "1.2.3",
      instrumentFetch: false,
      captureErrors: false,
    });
    const telemetry = createTelemetry(config);
    shutdowns.unshift(() => telemetry.shutdown());

    telemetry.tracer.startSpan("contract-span").end();
    telemetry.logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "contract-log",
    });
    telemetry.meter.createCounter("contract.counter").add(1);

    await telemetry.flush();

    expect(received.map(request => request.path).sort()).toEqual([
      "/otel/v1/logs",
      "/otel/v1/metrics",
      "/otel/v1/traces",
    ]);
    for (const request of received) {
      expect(request.authorization).toBe(`Bearer ${publicKey}`);
      expect(request.contentType).toMatch(/application\/json/);
      expect(request.body.length).toBeGreaterThan(0);
      expect(request.body.toString("utf8")).not.toContain(
        publicKey,
      );
      expect(request.body.toString("utf8")).toContain("contract-frontend");
    }
  });
});
