import { describe, expect, it } from "vitest";

import {
  redactText,
  sanitizeAttributes,
  sanitizeUrl,
  serializeError,
} from "../../src/privacy/sanitizer";

describe("privacy sanitizer", () => {
  it("preserves URL origin and pathname while removing query and fragment", () => {
    expect(
      sanitizeUrl(
        "https://api.example.com/api/v2/comprobantes?token=secret#fragment",
      ),
    ).toBe("https://api.example.com/api/v2/comprobantes");
  });

  it("redacts URL query strings embedded in text", () => {
    expect(
      redactText(
        "failed https://api.example.com/orders?token=secret#details now",
      ),
    ).toBe("failed https://api.example.com/orders now");
  });

  it("protects reserved and sensitive attributes", () => {
    expect(
      sanitizeAttributes({
        safe: "yes",
        authorization: "Bearer secret",
        "sentinel.internal": "override",
        "service.name": "override",
        nested: { secret: true },
      }),
    ).toEqual({
      safe: "yes",
      authorization: "[REDACTED]",
    });
  });

  it("survives hostile getters", () => {
    const attributes = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(attributes, "bad", {
      enumerable: true,
      get() {
        throw new Error("secret");
      },
    });
    attributes.good = 1;

    expect(sanitizeAttributes(attributes)).toEqual({ good: 1 });
  });

  it("bounds error data and sanitizes URLs", () => {
    const error = new Error(
      "request failed: https://example.com/path?password=secret#token",
    );

    const serialized = serializeError(error);
    expect(serialized.type).toBe("Error");
    expect(serialized.message).toContain("https://example.com/path");
    expect(JSON.stringify(serialized)).not.toContain("password=secret");
    expect(JSON.stringify(serialized)).not.toContain("#token");
  });
});
