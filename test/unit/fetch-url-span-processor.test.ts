import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
} from "@opentelemetry/sdk-trace-web";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_SERVER_ADDRESS,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";
import { describe, expect, it, vi } from "vitest";

import { FetchUrlSpanProcessor } from "../../src/privacy/fetch-url-span-processor";

describe("FetchUrlSpanProcessor", () => {
  function createSpan(
    url: unknown,
    method: unknown,
    instrumentationScope = "@opentelemetry/instrumentation-fetch",
  ): {
    attributes: Record<string, unknown>;
    setAttribute: ReturnType<typeof vi.fn>;
    span: Span;
    updateName: ReturnType<typeof vi.fn>;
  } {
    const attributes: Record<string, unknown> = {
      [ATTR_HTTP_REQUEST_METHOD]: method,
      [ATTR_URL_FULL]: url,
    };
    const setAttribute = vi.fn((key: string, value: unknown) => {
      attributes[key] = value;
    });
    const updateName = vi.fn();
    const span = {
      attributes,
      instrumentationScope: { name: instrumentationScope },
      setAttribute,
      updateName,
    } as unknown as Span;

    return { attributes, setAttribute, span, updateName };
  }

  function start(span: Span): void {
    new FetchUrlSpanProcessor().onStart(span, {} as Context);
  }

  it.each([
    ["GET", "https://api.example.com/products", "GET /products"],
    ["POST", "https://api.example.com/cart", "POST /cart"],
    ["GET", "https://example.com/", "GET /"],
  ])("names a %s fetch to %s as %s", (method, url, expectedName) => {
    const { span, updateName } = createSpan(url, method);

    start(span);

    expect(updateName).toHaveBeenCalledOnce();
    expect(updateName).toHaveBeenCalledWith(expectedName);
  });

  it("uses only the sanitized pathname in the name and URL attributes", () => {
    const { attributes, span, updateName } = createSpan(
      "https://api.example.com/products?page=2&token=secret#fragment",
      "GET",
    );

    start(span);

    expect(attributes[ATTR_URL_FULL]).toBe(
      "https://api.example.com/products",
    );
    expect(attributes[ATTR_URL_PATH]).toBe("/products");
    expect(attributes[ATTR_URL_SCHEME]).toBe("https");
    expect(attributes[ATTR_SERVER_ADDRESS]).toBe("api.example.com");
    expect(updateName).toHaveBeenCalledWith("GET /products");
    const exportedData = JSON.stringify({
      attributes,
      name: updateName.mock.calls,
    });
    expect(exportedData).not.toContain("page=2");
    expect(exportedData).not.toContain("token=secret");
    expect(exportedData).not.toContain("fragment");
  });

  it("strips a fragment from the span name", () => {
    const { span, updateName } = createSpan(
      "https://example.com/products#reviews",
      "GET",
    );

    start(span);

    expect(updateName).toHaveBeenCalledWith("GET /products");
  });

  it("does not normalize dynamic-looking path segments", () => {
    const { span, updateName } = createSpan(
      "https://api.example.com/products/550e8400-e29b-41d4-a716-446655440000",
      "GET",
    );

    start(span);

    expect(updateName).toHaveBeenCalledWith(
      "GET /products/550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("ignores unrelated instrumentation", () => {
    const { setAttribute, span, updateName } = createSpan(
      "https://example.com/path?secret=x",
      "GET",
      "example",
    );

    start(span);
    expect(setAttribute).not.toHaveBeenCalled();
    expect(updateName).not.toHaveBeenCalled();
  });

  it.each([undefined, "not a URL"])(
    "does not throw or rename when the URL is %s",
    url => {
      const { span, updateName } = createSpan(url, "GET");

      expect(() => start(span)).not.toThrow();
      expect(updateName).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "GET invalid"])(
    "does not invent a name when the HTTP method is %s",
    method => {
      const { attributes, span, updateName } = createSpan(
        "https://example.com/products?token=secret",
        method,
      );

      start(span);

      expect(updateName).not.toHaveBeenCalled();
      expect(attributes[ATTR_URL_FULL]).toBe("https://example.com/products");
      expect(attributes[ATTR_URL_PATH]).toBe("/products");
    },
  );

  it("normalizes a valid method to uppercase", () => {
    const { span, updateName } = createSpan(
      "https://example.com/products",
      "get",
    );

    start(span);

    expect(updateName).toHaveBeenCalledWith("GET /products");
  });

  it("has no buffering or exporting lifecycle behavior", async () => {
    const processor = new FetchUrlSpanProcessor();
    processor.onEnd({} as ReadableSpan);
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});
