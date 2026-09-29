import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { normalizeRumError } from "../../src/rum/normalize-error";

describe("RUM error normalization", () => {
  it("retains safe Error names and messages", () => {
    expect(normalizeRumError(new TypeError("Invalid product response"), "unhandledrejection"))
      .toMatchObject({ error_type: "TypeError", message: "Invalid product response" });
    expect(normalizeRumError(new Error("Something failed"), "error"))
      .toMatchObject({ error_type: "Error", message: "Something failed" });
    expect(normalizeRumError(new TypeError("Cannot read properties of undefined (reading 'id')"), "error"))
      .toMatchObject({ error_type: "TypeError", message: "Cannot read properties of undefined (reading 'id')" });
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
    expect(Object.keys(result).filter(key => key !== "stack").sort()).toEqual(["error_type", "message"]);
    expect(result.error_type).toMatch(/^[A-Za-z0-9._+~-]{1,128}$/);
    expect([...result.message].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && character !== "?" && character !== "#")).toBe(true);
    const unicode = normalizeRumError("é".repeat(800), "unhandledrejection");
    expect(new TextEncoder().encode(unicode.message).length).toBeLessThanOrEqual(1024);
    expect(unicode.message).toHaveLength(512);
  });

  it("reduces absolute URLs and rejects unsafe query markers", () => {
    expect(normalizeRumError(new Error("failed https://api.example.com/orders?token=secret#fragment now"), "error"))
      .toMatchObject({ error_type: "Error", message: "failed https://api.example.com/orders now" });
    expect(normalizeRumError("failed /orders?token=secret", "unhandledrejection"))
      .toEqual({ error_type: "UnhandledRejection", message: "Unhandled promise rejection" });
  });

  it("falls back for invalid names and messages", () => {
    const error = new Error("unsafe?token=secret");
    error.name = "Bad Name";
    expect(normalizeRumError(error, "error"))
      .toMatchObject({ error_type: "Error", message: "Browser error" });
    expect(normalizeRumError(new Error(""), "error"))
      .toMatchObject({ error_type: "Error", message: "Browser error" });
  });

  it("projects browser-provided V8 and Firefox frames without the header or function names", () => {
    const error = new Error("customer-secret");
    error.stack = "Error: customer-secret\n    at privateFn (https://cdn.example.com/users/alice/app.js?token=secret#fragment:12:3)\notherName@https://cdn.example.com/dynamic/chunk.mjs:45:6\n    at eval (eval at privateFn)";
    expect(normalizeRumError(error, "error")).toEqual({
      error_type: "Error", message: "customer-secret",
      stack: "at https://cdn.example.com/app.js:12:3\nat https://cdn.example.com/chunk.mjs:45:6",
    });
  });

  it("omits absent, hostile, or unrecognized stacks", () => {
    const missing = new Error("missing");
    Object.defineProperty(missing, "stack", { value: undefined });
    expect(normalizeRumError(missing, "error")).toEqual({ error_type: "Error", message: "missing" });
    const malformed = new Error("malformed");
    malformed.stack = "Error: malformed\nuser text https://site.test/app.js:1:2";
    expect(normalizeRumError(malformed, "error")).toEqual({ error_type: "Error", message: "malformed" });
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "stack", { get() { throw new Error("private"); } });
    expect(normalizeRumError(hostile, "unhandledrejection")).toEqual({ error_type: "Error", message: "hostile" });
  });

  it("keeps arbitrary rejections generic even when they have stack-like fields", () => {
    const value = { stack: "at https://site.test/app.js:1:2", message: "private", name: "TypeError" };
    expect(normalizeRumError(value, "unhandledrejection"))
      .toEqual({ error_type: "UnhandledRejection", message: "Unhandled promise rejection" });
  });

  it("rejects unsafe frame locations and bounds output bytes, lines, and frames", () => {
    const error = new Error("safe");
    error.stack = ["Error: private", "    at fn (https://alice:secret@site.test/app.js:1:2)", "    at fn (data:text/javascript,private:1:2)", "    at fn (https://site.test/private.txt:1:2)", "    at fn (https://site.test/app.js:0:2)", ...Array.from({ length: 70 }, (_, i) => `    at fn (https://site.test/dir/app.js:${i + 1}:2)`)].join("\n");
    const result = normalizeRumError(error, "error");
    const lines = result.stack?.split("\n") ?? [];
    expect(lines).toHaveLength(32);
    expect(lines[0]).toBe("at https://site.test/app.js:1:2");
    expect(lines.every(line => new TextEncoder().encode(line).length <= 512)).toBe(true);
    expect(new TextEncoder().encode(result.stack ?? "").length).toBeLessThanOrEqual(4096);
    expect(result.stack).not.toMatch(/[?#]|private|alice|secret/);
  });

  it("inspects at most 16384 UTF-16 units and never emits a partial location", () => {
    const error = new Error("safe");
    error.stack = `Error: safe\n${"😀".repeat(8200)}\n    at fn (https://site.test/app.js:2:3)`;
    expect(normalizeRumError(error, "error")).toEqual({ error_type: "Error", message: "safe" });
  });

  it("enforces 64 input lines, 512 bytes per frame, and 4096 bytes total", () => {
    const pastLineLimit = new Error("safe");
    pastLineLimit.stack = ["Error: safe", ...Array(63).fill("unrecognized"), "    at fn (https://site.test/app.js:1:2)"].join("\n");
    expect(normalizeRumError(pastLineLimit, "error").stack).toBeUndefined();

    const longFrame = new Error("safe");
    longFrame.stack = `Error: safe\n    at fn (https://${"a".repeat(500)}.test/app.js:1:2)`;
    expect(normalizeRumError(longFrame, "error").stack).toBeUndefined();

    const total = new Error("safe");
    total.stack = ["Error: safe", ...Array.from({ length: 32 }, (_, i) => `    at fn (https://site.test/${"a".repeat(125)}.js:${i + 1}:2)`)].join("\n");
    const output = normalizeRumError(total, "error").stack;
    expect(output).toBeDefined();
    expect(output!.split("\n").length).toBeLessThan(32);
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(4096);
    expect(output!.split("\n").every(frame => new TextEncoder().encode(frame).length <= 512)).toBe(true);
  });

  it("never treats a URL-shaped header or Unicode/user path as a frame", () => {
    const error = new Error("safe");
    error.stack = "https://site.test/app.js:1:2\n    at fn (https://site.test/😀/appé.js:3:4)\n    at fn (https://site.test/assets/app.js?name=😀#private:5:6)";
    expect(normalizeRumError(error, "error").stack).toBe("at https://site.test/app.js:5:6");
  });

  it("keeps different stacks out of the v1 fingerprint identity", () => {
    const first = new Error("same failure");
    first.name = "TypeError";
    first.stack = "TypeError: same failure\n    at a (https://site.test/a.js:1:2)";
    const second = new Error("same failure");
    second.name = "TypeError";
    second.stack = "TypeError: same failure\n    at b (https://site.test/b.js:9:8)";
    const a = normalizeRumError(first, "error");
    const b = normalizeRumError(second, "error");
    expect(a.stack).not.toBe(b.stack);
    const fingerprint = (value: typeof a) => `rum-error-v1-${createHash("sha256").update(`sentinel-rum-error/v1\0javascript_error\0${value.error_type}\0${value.message}`).digest("hex")}`;
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});
