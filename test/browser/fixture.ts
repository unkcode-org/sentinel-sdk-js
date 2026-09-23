import { Sentinel } from "../../src";
import type { SentinelTelemetryDraft } from "../../src";

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
  errorInsideSpan() {
    sentinel?.startActiveSpan("rum.interaction", () => {
      sentinel?.captureException(new Error("secret@example.com?token=hidden"));
    });
  },
  async flush() {
    await new Promise(resolve => setTimeout(resolve, 500));
    await sentinel?.flush();
  },
  async shutdown() {
    await sentinel?.shutdown();
    sentinel = undefined;
  },
};

declare global {
  interface Window {
    sentinelFixture: typeof fixture;
  }
}

window.sentinelFixture = fixture;
