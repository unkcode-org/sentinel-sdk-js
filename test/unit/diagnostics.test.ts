import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeConfig } from "../../src/config";
import { installDiagnostics } from "../../src/diagnostics";
import { applyBeforeSend } from "../../src/privacy/before-send";

describe("safe diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never prints hook errors, URLs, payloads, or credentials", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const diagnostics = installDiagnostics(true);
    const config = normalizeConfig({
      endpoint: "https://ingest.example.com",
      publicKey: "sip_pub_diagnostic_secret",
      serviceName: "test",
      diagnostics: true,
      beforeSend() {
        throw new Error(
          "sip_pub_diagnostic_secret https://example.com/path?token=secret payload",
        );
      },
    });

    expect(
      applyBeforeSend(
        config,
        { signal: "log", name: "test", attributes: {} },
        diagnostics,
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith("[Sentinel/OpenTelemetry] warn");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /sip_pub_|token=secret|payload|example\.com/,
    );
    diagnostics.disable();
  });

  it("rate-limits repeated messages", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const diagnostics = installDiagnostics(true);
    for (let index = 0; index < 20; index += 1) {
      diagnostics.beforeSendFailure();
    }
    expect(warn).toHaveBeenCalledTimes(5);
    diagnostics.disable();
  });
});
