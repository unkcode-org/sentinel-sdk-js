import { describe, expect, it } from "vitest";

import { normalizeConfig, SentinelInitializationError } from "../../src/config";

const valid = {
  endpoint: "https://ingest.example.com/otel",
  publicKey: "sip_pub_test123",
  serviceName: "frontend",
} as const;

describe("normalizeConfig", () => {
  it("builds signal endpoints while preserving a path prefix", () => {
    const config = normalizeConfig(valid);

    expect(config.signalUrls).toEqual({
      traces: "https://ingest.example.com/otel/v1/traces",
      logs: "https://ingest.example.com/otel/v1/logs",
      metrics: "https://ingest.example.com/otel/v1/metrics",
    });
    expect(config.instrumentFetch).toBe(true);
    expect(config.captureErrors).toBe(true);
    expect(config.tracesSampleRate).toBe(1);
  });

  it.each([
    ["invalid key", { ...valid, publicKey: "secret" }],
    ["endpoint query", { ...valid, endpoint: "https://example.com?key=x" }],
    ["endpoint fragment", { ...valid, endpoint: "https://example.com/#x" }],
    ["endpoint credentials", { ...valid, endpoint: "https://u:p@example.com" }],
    ["insecure remote endpoint", { ...valid, endpoint: "http://example.com" }],
    ["empty service", { ...valid, serviceName: "  " }],
    ["invalid sample rate", { ...valid, tracesSampleRate: 1.1 }],
  ])("rejects %s", (_name, candidate) => {
    expect(() => normalizeConfig(candidate)).toThrow(SentinelInitializationError);
  });

  it("allows loopback HTTP for development", () => {
    expect(
      normalizeConfig({ ...valid, endpoint: "http://127.0.0.1:4318" })
        .signalUrls.traces,
    ).toBe("http://127.0.0.1:4318/v1/traces");
  });

  it("normalizes propagation URL targets and rejects exporter targets", () => {
    expect(
      normalizeConfig({
        ...valid,
        tracePropagationTargets: ["https://api.example.com/"],
      }).tracePropagationTargets,
    ).toEqual(["https://api.example.com"]);

    expect(() =>
      normalizeConfig({
        ...valid,
        tracePropagationTargets: ["https://ingest.example.com/otel"],
      }),
    ).toThrow(/exporter URLs/);
    expect(() =>
      normalizeConfig({
        ...valid,
        tracePropagationTargets: [/ingest\.example\.com/],
      }),
    ).toThrow(/exporter URLs/);
  });
});
