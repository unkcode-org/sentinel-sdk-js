import { describe, expect, it, vi } from "vitest";

import { installBrowserErrorCapture } from "../../src/instrumentation/errors";

describe("browser error capture", () => {
  it("captures errors and unhandled rejections without preventing defaults", () => {
    const target = new EventTarget();
    const capture = vi.fn();
    const installed = installBrowserErrorCapture(capture, target);
    expect(installed).toBeDefined();

    const errorEvent = new Event("error", { cancelable: true });
    Object.defineProperties(errorEvent, {
      error: { value: new Error("boom") },
      message: { value: "boom" },
      filename: { value: "https://example.com/app.js?token=secret" },
      lineno: { value: 12 },
      colno: { value: 3 },
    });
    target.dispatchEvent(errorEvent);

    const rejectionEvent = new Event("unhandledrejection", { cancelable: true });
    Object.defineProperty(rejectionEvent, "reason", {
      value: new Error("rejected"),
    });
    target.dispatchEvent(rejectionEvent);

    expect(capture).toHaveBeenCalledTimes(2);
    expect(errorEvent.defaultPrevented).toBe(false);
    expect(rejectionEvent.defaultPrevented).toBe(false);
    expect(JSON.stringify(capture.mock.calls)).not.toContain("token=secret");

    installed?.disable();
    target.dispatchEvent(errorEvent);
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
