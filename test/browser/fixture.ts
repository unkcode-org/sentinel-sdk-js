import { Sentinel } from "../../src";
import type { SentinelTelemetryDraft } from "../../src";
import type { RumRuntime } from "../../src/rum/runtime";

let sentinel: Sentinel | undefined;
const drafts: SentinelTelemetryDraft[] = [];

const fixture = {
  drafts,
  init(endpoint: string, tracePropagationTargets: string[] = []) {
    sentinel = Sentinel.init({
      endpoint,
      publicKey: "sip_pub_0000000000000000000000000000000000000000000",
      serviceName: "browser-test",
      release: "0.1.0-test",
      tracePropagationTargets,
      beforeSend(draft) {
        drafts.push(structuredClone(draft));
        return draft;
      },
    });
  },
  initRum(endpoint: string) {
    sentinel = Sentinel.init({
      endpoint,
      publicKey: "sip_pub_0000000000000000000000000000000000000000000",
      serviceName: "browser-test",
      release: "0.1.0-test",
      rum: { enabled: true },
    });
  },
  initErrorMode(endpoint: string, captureErrors: boolean, rumEnabled: boolean) {
    const counts = { error: 0, unhandledrejection: 0 };
    const original = window.addEventListener;
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "error" || type === "unhandledrejection") counts[type]++;
      return original.call(window, type, listener, options);
    }) as typeof window.addEventListener;
    try {
      sentinel = Sentinel.init({
        endpoint,
        publicKey: "sip_pub_0000000000000000000000000000000000000000000",
        serviceName: "browser-test",
        captureErrors,
        rum: { enabled: rumEnabled },
      });
    } finally {
      window.addEventListener = original;
    }
    return counts;
  },
  async fetchString(url: string) {
    await fetch(url);
  },
  async fetchRequest(url: string) {
    await fetch(new Request(url));
  },
  logUrl(url: string) {
    sentinel?.info(url, { requestUrl: url });
  },
  dispatchError(url: string) {
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error(`failed ${url}`),
        message: `failed ${url}`,
        filename: url,
        lineno: 10,
        colno: 2,
      }),
    );
  },
  dispatchRejection() {
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: new Error("rejected secret@example.com") });
    window.dispatchEvent(event);
  },
  dispatchTypedRejection() {
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: new TypeError("RUM test rejection") });
    window.dispatchEvent(event);
  },
  dispatchStackedErrors() {
    const windowError = new Error("RUM window stack");
    windowError.stack = "Error: private-header\n    at privateFn (https://example.com/users/alice/app.js?token=secret#fragment:12:3)";
    window.dispatchEvent(new ErrorEvent("error", { error: windowError, message: windowError.message, filename: "https://example.com/app.js?token=secret", lineno: 12, colno: 3 }));
    const rejection = new TypeError("RUM rejection stack");
    rejection.stack = "TypeError: private-header\nprivateFn@https://example.com/dynamic/chunk.mjs?secret=yes:45:6";
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: rejection });
    window.dispatchEvent(event);
  },
  dispatchObjectRejection() {
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: { token: "must-not-leak", nested: { private: "data" } } });
    window.dispatchEvent(event);
  },
  manualException() {
    sentinel?.captureException(new Error("manual secret@example.com"));
  },
  errorInsideSpan() {
    sentinel?.startActiveSpan("rum.interaction", () => {
      (sentinel as unknown as { rum?: RumRuntime }).rum?.observeError(new Error("secret@example.com?token=hidden"), "error");
    });
  },
  rumPendingState() {
    const runtime = (sentinel as unknown as { rum?: { pending: Set<unknown>; observer?: MutationObserver } })?.rum;
    return { count: runtime?.pending.size ?? 0, observing: runtime?.observer !== undefined };
  },
  rumPointerState() {
    const runtime = (sentinel as unknown as { rum?: { presses: Map<number, unknown>; attempts: Set<unknown>; rageAttempts: unknown[] } })?.rum;
    return { active: runtime?.presses.size ?? 0, provisional: runtime?.attempts.size ?? 0, history: runtime?.rageAttempts.length ?? 0 };
  },
  rumCancelPointerForTest(pointerId: number) {
    const runtime = (sentinel as unknown as { rum?: { onPointerCancel: (event: PointerEvent) => void } })?.rum;
    runtime?.onPointerCancel({ isTrusted: true, pointerId } as PointerEvent);
  },
  rumWrongPointerUpForTest(pointerId: number, target: Element) {
    const runtime = (sentinel as unknown as { rum?: { onPointerUp: (event: PointerEvent) => void } })?.rum;
    runtime?.onPointerUp({ isTrusted: true, isPrimary: true, button: 0, pointerId,
      clientX: 100, clientY: 500, target } as unknown as PointerEvent);
  },
  rumSecondTouchForTest() {
    const runtime = (sentinel as unknown as { rum?: { onPointerDown: (event: PointerEvent) => void } })?.rum;
    runtime?.onPointerDown({ isTrusted: true, pointerType: "touch", isPrimary: false } as PointerEvent);
  },
  rumPrimaryPointerForTest(pointerId: number, target: Element) {
    const runtime = (sentinel as unknown as { rum?: { onPointerDown: (event: PointerEvent) => void } })?.rum;
    runtime?.onPointerDown({ isTrusted: true, pointerType: "pen", isPrimary: true, button: 0,
      pointerId, clientX: 100, clientY: 500, target } as unknown as PointerEvent);
  },
  async flush() {
    await new Promise(resolve => setTimeout(resolve, 500));
    await sentinel?.flush();
  },
  async flushNow() {
    await sentinel?.flush();
  },
  async shutdown() {
    await sentinel?.shutdown();
    sentinel = undefined;
  },
  async shutdownWithPendingState() {
    const runtime = (sentinel as unknown as { rum?: { pending: Set<unknown>; observer?: MutationObserver } })?.rum;
    await sentinel?.shutdown();
    sentinel = undefined;
    return { count: runtime?.pending.size ?? 0, observing: runtime?.observer !== undefined };
  },
  async shutdownWithPointerState() {
    const runtime = (sentinel as unknown as { rum?: { presses: Map<number, unknown>; attempts: Set<unknown>; rageAttempts: unknown[] } })?.rum;
    await sentinel?.shutdown();
    sentinel = undefined;
    return { active: runtime?.presses.size ?? 0, provisional: runtime?.attempts.size ?? 0, history: runtime?.rageAttempts.length ?? 0 };
  },
};

declare global {
  interface Window {
    sentinelFixture: typeof fixture;
  }
}

window.sentinelFixture = fixture;
