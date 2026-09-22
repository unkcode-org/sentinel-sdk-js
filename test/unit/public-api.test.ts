import { describe, expect, it } from "vitest";

import { Sentinel } from "../../src/index";

describe("public API", () => {
  it("exposes the Sentinel initializer", () => {
    expect(Sentinel.init).toBeTypeOf("function");
  });
});
