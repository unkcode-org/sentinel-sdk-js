import { describe, expect, it, vi } from "vitest";

import { normalizeConfig } from "../../src/config";
import { applyBeforeSend } from "../../src/privacy/before-send";

describe("beforeSend", () => {
  it("receives a sanitized draft and re-sanitizes its replacement", () => {
    const hook = vi.fn(draft => ({
      ...draft,
      body: `${draft.body} https://example.com/path?secret=hook#fragment`,
      attributes: {
        ...draft.attributes,
        "service.name": "override",
        token: "hook-secret",
      },
    }));
    const config = normalizeConfig({
      endpoint: "https://ingest.example.com",
      publicKey: "sip_pub_0000000000000000000000000000000000000000000",
      serviceName: "frontend",
      beforeSend: hook,
    });

    const output = applyBeforeSend(config, {
      signal: "log",
      name: "log",
      body: "https://example.com/path?secret=input#fragment",
      attributes: { requestUrl: "https://example.com/orders?token=input" },
    });

    expect(hook).toHaveBeenCalledOnce();
    expect(JSON.stringify(hook.mock.calls[0]?.[0])).not.toContain("secret=input");
    expect(output).toEqual({
      signal: "log",
      name: "log",
      body: "https://example.com/path https://example.com/path",
      attributes: {
        requestUrl: "https://example.com/orders",
        token: "[REDACTED]",
      },
    });
  });

  it("drops telemetry when the hook returns null or throws", () => {
    const dropped = normalizeConfig({
      endpoint: "https://ingest.example.com",
      publicKey: "sip_pub_0000000000000000000000000000000000000000000",
      serviceName: "frontend",
      beforeSend: () => null,
    });
    expect(
      applyBeforeSend(dropped, {
        signal: "span",
        name: "drop",
        attributes: {},
      }),
    ).toBeNull();

    const throwing = normalizeConfig({
      endpoint: "https://ingest.example.com",
      publicKey: "sip_pub_0000000000000000000000000000000000000000000",
      serviceName: "frontend",
      beforeSend: () => {
        throw new Error("secret");
      },
    });
    expect(
      applyBeforeSend(throwing, {
        signal: "span",
        name: "drop",
        attributes: {},
      }),
    ).toBeNull();
  });
});
