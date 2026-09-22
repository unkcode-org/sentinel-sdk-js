import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { TracerProvider } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import { Sentinel, SentinelInitializationError } from "../../src/index";

const baseConfig = {
  endpoint: "http://127.0.0.1:4318",
  publicKey: "sip_pub_ownership",
  serviceName: "ownership-test",
  instrumentFetch: false,
  captureErrors: false,
} as const;

describe("Sentinel OpenTelemetry ownership", () => {
  let active: Sentinel | undefined;

  afterEach(async () => {
    await active?.shutdown();
    active = undefined;
    trace.disable();
    propagation.disable();
    context.disable();
    metrics.disable();
    logs.disable();
  });

  it("returns the same instance for an equivalent duplicate init", () => {
    active = Sentinel.init(baseConfig);
    expect(Sentinel.init({ ...baseConfig })).toBe(active);
  });

  it("rejects a duplicate init with different configuration", () => {
    active = Sentinel.init(baseConfig);
    expect(() =>
      Sentinel.init({ ...baseConfig, serviceName: "different" }),
    ).toThrow(SentinelInitializationError);
  });

  it("fails deterministically when a tracer provider already owns the global", () => {
    trace.setGlobalTracerProvider({} as TracerProvider);

    expect(() => Sentinel.init(baseConfig)).toThrow(
      /global OpenTelemetry tracer provider/i,
    );
  });

  it("does not install logger or meter providers globally", () => {
    const loggerProvider = logs.getLoggerProvider();
    const meterProvider = metrics.getMeterProvider();

    active = Sentinel.init(baseConfig);

    expect(logs.getLoggerProvider()).toBe(loggerProvider);
    expect(metrics.getMeterProvider()).toBe(meterProvider);
  });

  it("fails before global registration when fetch is already wrapped", () => {
    const originalFetch = globalThis.fetch;
    const wrapped = (() => Promise.reject(new Error("unused"))) as typeof fetch & {
      __original?: typeof fetch;
      __unwrap?: () => void;
      __wrapped?: boolean;
    };
    wrapped.__original = originalFetch;
    wrapped.__unwrap = () => undefined;
    wrapped.__wrapped = true;
    globalThis.fetch = wrapped;

    try {
      expect(() =>
        Sentinel.init({ ...baseConfig, instrumentFetch: true }),
      ).toThrow(/fetch is already instrumented/i);
      expect(trace.getTracerProvider()).not.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("releases owned globals during shutdown", async () => {
    active = Sentinel.init(baseConfig);
    await active.shutdown();
    active = undefined;

    expect(() => Sentinel.init(baseConfig)).not.toThrow();
    active = Sentinel.init(baseConfig);
  });

  it("makes flush repeatable and shutdown idempotent", async () => {
    active = Sentinel.init(baseConfig);
    await active.flush();
    await active.flush();

    const first = active.shutdown();
    const second = active.shutdown();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    active = undefined;
  });
});
