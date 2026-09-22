import { trace } from "@opentelemetry/api";
import type { TracerProvider } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../../src/config";
import { prepareFetchInstrumentation } from "../../src/instrumentation/fetch";

describe("official fetch instrumentation configuration", () => {
  it("ignores every exporter URL and configures additional propagation targets", () => {
    const config = normalizeConfig({
      endpoint: "https://ingest.example.com/prefix",
      publicKey: "sip_pub_fetch",
      serviceName: "frontend",
      tracePropagationTargets: [
        "https://api.example.com/api",
        /^https:\/\/secondary\.example\.com\//,
      ],
    });
    const prepared = prepareFetchInstrumentation(
      config,
      trace.getTracerProvider(),
    );
    expect(prepared).toBeDefined();
    const instrumentationConfig = prepared?.instrumentation.getConfig();

    for (const signalUrl of Object.values(config.signalUrls)) {
      expect(
        instrumentationConfig?.ignoreUrls?.some(pattern =>
          typeof pattern === "string"
            ? pattern === signalUrl
            : pattern.test(signalUrl),
        ),
      ).toBe(true);
    }

    const targets = instrumentationConfig?.propagateTraceHeaderCorsUrls;
    expect(Array.isArray(targets)).toBe(true);
    expect(
      (targets as (string | RegExp)[]).some(target =>
        target instanceof RegExp
          ? target.test("https://api.example.com/api/v2/orders?x=1")
          : false,
      ),
    ).toBe(true);
    expect(instrumentationConfig?.measureRequestSize).toBe(false);
  });

  it("returns no instrumentation when disabled", () => {
    const config = normalizeConfig({
      endpoint: "https://ingest.example.com",
      publicKey: "sip_pub_fetch",
      serviceName: "frontend",
      instrumentFetch: false,
    });
    expect(
      prepareFetchInstrumentation(config, {} as TracerProvider),
    ).toBeUndefined();
  });
});
