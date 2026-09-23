import { describe, expect, it } from "vitest";

import { normalizeConfig, SentinelInitializationError } from "../../src/config";

const valid = {
  endpoint: "https://ingest.example.com/otel",
  publicKey: `sip_pub_${"a".repeat(43)}`,
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

  it.each([
    ["exactly 43 characters", "a".repeat(43)],
    ["uppercase ASCII letters", "A".repeat(43)],
    ["lowercase ASCII letters", "z".repeat(43)],
    ["digits", "7".repeat(43)],
    ["hyphens", "-".repeat(43)],
    ["underscores", "_".repeat(43)],
  ])("accepts a public credential containing %s", (_name, suffix) => {
    expect(
      normalizeConfig({ ...valid, publicKey: `sip_pub_${suffix}` }).publicKey,
    ).toBe(`sip_pub_${suffix}`);
  });

  it.each([
    ["a 42-character suffix", `sip_pub_${"a".repeat(42)}`],
    ["a 44-character suffix", `sip_pub_${"a".repeat(44)}`],
    ["a period", `sip_pub_${"a".repeat(42)}.`],
    ["a tilde", `sip_pub_${"a".repeat(42)}~`],
    ["a plus sign", `sip_pub_${"a".repeat(42)}+`],
    ["a slash", `sip_pub_${"a".repeat(42)}/`],
    ["an equals sign", `sip_pub_${"a".repeat(42)}=`],
    ["whitespace", `sip_pub_${"a".repeat(42)} `],
    ["a private credential", `sip_${"a".repeat(43)}`],
    ["text before the public prefix", `prefix-sip_pub_${"a".repeat(43)}`],
  ])("rejects a credential with %s", (_name, publicKey) => {
    expect(() => normalizeConfig({ ...valid, publicKey })).toThrow(
      SentinelInitializationError,
    );
  });

  it("does not echo an invalid credential in its error", () => {
    const publicKey = "secret-containing-sip_pub_but-not-a-credential";

    expect(() => normalizeConfig({ ...valid, publicKey })).toThrow(
      expect.objectContaining({
        message: "publicKey must be a valid Sentinel public credential",
      }),
    );
    try {
      normalizeConfig({ ...valid, publicKey });
    } catch (error) {
      expect(String(error)).not.toContain(publicKey);
    }
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
