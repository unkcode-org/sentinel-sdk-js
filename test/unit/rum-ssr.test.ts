import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../../src/config";
import { RumRuntime } from "../../src/rum/runtime";
import { installDiagnostics } from "../../src/diagnostics";

describe("RUM outside a browser", () => {
  it("can be imported and enabled without browser globals", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    const config = normalizeConfig({
      endpoint: "https://ingest.example.com",
      publicKey: `sip_pub_${"a".repeat(43)}`,
      serviceName: "frontend",
      rum: { enabled: true },
    });
    expect(RumRuntime.start(config, installDiagnostics(false))).toBeUndefined();
  });
});
