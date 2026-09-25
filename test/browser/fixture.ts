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
};

declare global {
  interface Window {
    sentinelFixture: typeof fixture;
  }
}

window.sentinelFixture = fixture;
