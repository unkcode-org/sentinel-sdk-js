import type { SentinelAttributes } from "../config";
import { sanitizeUrl } from "../privacy/sanitizer";

export type ExceptionCapture = (
  error: unknown,
  attributes?: SentinelAttributes,
) => void;

export interface BrowserErrorCapture {
  disable(): void;
}

interface ErrorEventShape extends Event {
  readonly error?: unknown;
  readonly message?: string;
  readonly filename?: string;
  readonly lineno?: number;
  readonly colno?: number;
}

interface RejectionEventShape extends Event {
  readonly reason?: unknown;
}

export function installBrowserErrorCapture(
  capture: ExceptionCapture,
  target?: EventTarget,
): BrowserErrorCapture | undefined {
  const eventTarget =
    target ?? (typeof window === "undefined" ? undefined : window);
  if (eventTarget === undefined) return undefined;

  const seen = new WeakSet<object>();
  const captureOnce = (error: unknown, attributes?: SentinelAttributes) => {
    if (typeof error === "object" && error !== null) {
      if (seen.has(error)) return;
      seen.add(error);
    }
    capture(error, attributes);
  };
  const onError = (event: Event) => {
    const errorEvent = event as ErrorEventShape;
    captureOnce(errorEvent.error ?? errorEvent.message ?? "Browser error", {
      ...(errorEvent.filename
        ? { "exception.source": sanitizeUrl(errorEvent.filename) ?? "[REDACTED]" }
        : {}),
      ...(typeof errorEvent.lineno === "number"
        ? { "exception.lineno": errorEvent.lineno }
        : {}),
      ...(typeof errorEvent.colno === "number"
        ? { "exception.colno": errorEvent.colno }
        : {}),
    });
  };
  const onUnhandledRejection = (event: Event) => {
    captureOnce(
      (event as RejectionEventShape).reason ?? "Unhandled promise rejection",
      { "exception.mechanism": "unhandledrejection" },
    );
  };

  eventTarget.addEventListener("error", onError);
  eventTarget.addEventListener("unhandledrejection", onUnhandledRejection);
  let enabled = true;
  return {
    disable() {
      if (!enabled) return;
      enabled = false;
      eventTarget.removeEventListener("error", onError);
      eventTarget.removeEventListener("unhandledrejection", onUnhandledRejection);
    },
  };
}
