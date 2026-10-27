import { Sentinel } from "../../src";
import { Replayer, record } from "rrweb";

let sentinel: Sentinel | undefined;
const fixture = {
  init(endpoint: string, enabled = true, visualOrigins?: string[]) {
    document.cookie = "replay_test=cookie-secret; path=/";
    localStorage.setItem("replay-test", "local-storage-secret");
    sessionStorage.setItem("replay-test", "session-storage-secret");
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML = "<span>shadow-secret</span>";
    document.body.append(host);
    const closedHost = document.createElement("div");
    closedHost.attachShadow({ mode: "closed" }).innerHTML = "<span>closed-shadow-secret</span>";
    document.body.append(closedHost);
    sentinel = Sentinel.init({ endpoint, publicKey: "sip_pub_0000000000000000000000000000000000000000000",
      serviceName: "replay-browser-test", rum: { enabled: true }, replay: { enabled,
        ...(visualOrigins ? { visual: { enabled: true, resourceOrigins: visualOrigins }, unmaskTextSelector: ".public-label" } : {}) } });
  },
  trigger() {
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("fixture error"), message: "fixture error" }));
  },
  emitSemanticTrigger(type: "javascript_error" | "network_error" | "rage_click" | "dead_click") {
    const rum = (sentinel as unknown as { rum?: { emit: (type: string) => void } })?.rum;
    rum?.emit(type);
  },
  mutate() {
    const safe = document.querySelector("#safe");
    if (safe) safe.textContent = "dynamic-secret-text";
    safe?.setAttribute("data-secret", "dynamic-attribute-secret");
    const privateNode = document.querySelector("[data-sentinel-private]");
    if (privateNode) {
      const child = document.createElement("span");
      child.textContent = "dynamic-private-secret";
      privateNode.append(child);
      privateNode.setAttribute("title", "dynamic-private-attribute-secret");
    }
  },
  status() { return sentinel?.replayStatus(); },
  bufferStats() {
    const replay = (sentinel as unknown as { replay?: { groups: { bytes: number; events: unknown[] }[] } })?.replay;
    return { bytes: replay?.groups.reduce((n, group) => n + group.bytes, 0) ?? 0,
      events: replay?.groups.reduce((n, group) => n + group.events.length, 0) ?? 0,
      groups: replay?.groups.length ?? 0 };
  },
  forceCheckpoint() { record.takeFullSnapshot(true); },
  reconstruct(events: unknown[]): boolean {
    const root = document.createElement("div");
    root.setAttribute("data-sentinel-private", "");
    document.body.append(root);
    try {
      const replayer = new Replayer(events as ConstructorParameters<typeof Replayer>[0], { root, UNSAFE_replayCanvas: false });
      replayer.pause();
      replayer.destroy();
      return true;
    } catch { return false; }
    finally { root.remove(); }
  },
  async reconstructLayout(events: unknown[]): Promise<{ background: string; display: string; width: string; text: string } | null> {
    const root = document.createElement("section");
    root.setAttribute("data-sentinel-private", "");
    document.body.append(root);
    const replayer = new Replayer(events as ConstructorParameters<typeof Replayer>[0], { root, UNSAFE_replayCanvas: false });
    try {
      await new Promise<void>(resolve => replayer.on("fullsnapshot-rebuilded", () => resolve()));
      replayer.pause(0);
      const frame = root.querySelector("iframe");
      const element = frame?.contentDocument?.querySelector("main");
      if (!element || !frame?.contentWindow) return null;
      const style = frame.contentWindow.getComputedStyle(element);
      return { background: style.backgroundColor, display: style.display, width: style.width, text: element.textContent ?? "" };
    } finally { replayer.destroy(); root.remove(); }
  },
  async shutdown() { await sentinel?.shutdown(); sentinel = undefined; },
};
declare global { interface Window { replayFixture: typeof fixture } }
window.replayFixture = fixture;
