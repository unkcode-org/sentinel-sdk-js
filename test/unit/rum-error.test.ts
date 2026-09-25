import { describe, expect, it } from "vitest";

import { normalizeRumError } from "../../src/rum/normalize-error";

describe("RUM error normalization", () => {
  it("retains safe Error names and messages", () => {
    expect(normalizeRumError(new TypeError("Invalid product response"), "unhandledrejection"))
      .toEqual({ error_type: "TypeError", message: "Invalid product response" });
    expect(normalizeRumError(new Error("Something failed"), "error"))
      .toEqual({ error_type: "Error", message: "Something failed" });
    expect(normalizeRumError(new TypeError("Cannot read properties of undefined (reading 'id')"), "error"))
      .toEqual({ error_type: "TypeError", message: "Cannot read properties of undefined (reading 'id')" });
  });

  it("retains bounded rejection strings with the generic type", () => {
    expect(normalizeRumError("Something failed", "unhandledrejection"))
      .toEqual({ error_type: "UnhandledRejection", message: "Something failed" });
  });

  it("accepts safe DOMException fields when available", () => {
    const exception = new DOMException("The operation was aborted", "AbortError");
    expect(normalizeRumError(exception, "unhandledrejection"))
      .toEqual({ error_type: "AbortError", message: "The operation was aborted" });
  });

  it("never reads or serializes arbitrary rejection values", () => {
    const object = { token: "super-secret-token", customer: { private: "data" } };
    const hostile = new Proxy(object, { get() { throw new Error("getter called"); } });
    const hostilePrototype = new Proxy(object, { getPrototypeOf() { throw new Error("prototype inspected"); } });
    const fallback = { error_type: "UnhandledRejection", message: "Unhandled promise rejection" };
    for (const value of [object, hostile, hostilePrototype, ["secret", { private: "data" }], null, undefined, 42, true, Symbol("secret"), () => "secret"]) {
      expect(normalizeRumError(value, "unhandledrejection")).toEqual(fallback);
    }
    expect(normalizeRumError(object, "error"))
      .toEqual({ error_type: "Error", message: "Browser error" });
  });

  it("bounds messages and preserves the ingest v1 text contract", () => {
    const result = normalizeRumError(new Error("x".repeat(1500)), "error");
    expect(result.error_type).toBe("Error");
    expect(new TextEncoder().encode(result.message).length).toBeLessThanOrEqual(1024);
    expect(result.message).toHaveLength(1024);
    expect(Object.keys(result).sort()).toEqual(["error_type", "message"]);
    expect(result.error_type).toMatch(/^[A-Za-z0-9._+~-]{1,128}$/);
    expect([...result.message].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && character !== "?" && character !== "#")).toBe(true);
    const unicode = normalizeRumError("é".repeat(800), "unhandledrejection");
    expect(new TextEncoder().encode(unicode.message).length).toBeLessThanOrEqual(1024);
    expect(unicode.message).toHaveLength(512);
  });

  it("reduces absolute URLs and rejects unsafe query markers", () => {
    expect(normalizeRumError(new Error("failed https://api.example.com/orders?token=secret#fragment now"), "error"))
      .toEqual({ error_type: "Error", message: "failed https://api.example.com/orders now" });
    expect(normalizeRumError("failed /orders?token=secret", "unhandledrejection"))
      .toEqual({ error_type: "UnhandledRejection", message: "Unhandled promise rejection" });
  });

  it("falls back for invalid names and messages", () => {
    const error = new Error("unsafe?token=secret");
    error.name = "Bad Name";
    expect(normalizeRumError(error, "error"))
      .toEqual({ error_type: "Error", message: "Browser error" });
    expect(normalizeRumError(new Error(""), "error"))
      .toEqual({ error_type: "Error", message: "Browser error" });
  });
});
