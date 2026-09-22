import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
} from "@opentelemetry/sdk-trace-web";
import {
  ATTR_SERVER_ADDRESS,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";
import { describe, expect, it, vi } from "vitest";

import { FetchUrlSpanProcessor } from "../../src/privacy/fetch-url-span-processor";

describe("FetchUrlSpanProcessor", () => {
  it("sanitizes only official fetch spans through public span APIs", () => {
    const attributes: Record<string, unknown> = {
      [ATTR_URL_FULL]:
        "https://api.example.com/api/v2/comprobantes?token=secret#fragment",
    };
    const setAttribute = vi.fn((key: string, value: unknown) => {
      attributes[key] = value;
    });
    const span = {
      attributes,
      instrumentationScope: {
        name: "@opentelemetry/instrumentation-fetch",
      },
      setAttribute,
    } as unknown as Span;

    new FetchUrlSpanProcessor().onStart(span, {} as Context);

    expect(attributes[ATTR_URL_FULL]).toBe(
      "https://api.example.com/api/v2/comprobantes",
    );
    expect(attributes[ATTR_URL_PATH]).toBe("/api/v2/comprobantes");
    expect(attributes[ATTR_URL_SCHEME]).toBe("https");
    expect(attributes[ATTR_SERVER_ADDRESS]).toBe("api.example.com");
    expect(JSON.stringify(attributes)).not.toContain("token=secret");
    expect(JSON.stringify(attributes)).not.toContain("fragment");
  });

  it("ignores unrelated instrumentation", () => {
    const setAttribute = vi.fn();
    const span = {
      attributes: { [ATTR_URL_FULL]: "https://example.com/path?secret=x" },
      instrumentationScope: { name: "example" },
      setAttribute,
    } as unknown as Span;

    new FetchUrlSpanProcessor().onStart(span, {} as Context);
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("has no buffering or exporting lifecycle behavior", async () => {
    const processor = new FetchUrlSpanProcessor();
    processor.onEnd({} as ReadableSpan);
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});
