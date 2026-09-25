import { context, isSpanContextValid, trace } from "@opentelemetry/api";
import type { NormalizedSentinelConfig } from "../config";
import type { SentinelDiagnostics } from "../diagnostics";
import { normalizeRumError } from "./normalize-error";

export const RUM_BATCH_SIZE = 20;
export const RUM_QUEUE_SIZE = 200;
export const RUM_FLUSH_INTERVAL_MS = 5_000;
export const RUM_INACTIVITY_MS = 30 * 60_000;
const SESSION_KEY = "@unkcode/sentinel/rum-session-v1";
const ROUTE = /^\/[A-Za-z0-9/_~.-]*$/;
const SAFE_TEXT = /^[A-Za-z0-9._+~-]+$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const DEPTHS = [0.25, 0.5, 0.75, 0.9, 1] as const;

type EventType = "page_view" | "click" | "rage_click" | "dead_click" | "scroll_depth" | "javascript_error" | "network_error";
interface Position { viewport_x: number; viewport_y: number; document_x: number; document_y: number }
interface Target { tag?: string; role?: string; test_id?: string }
interface RumEvent {
  id: string;
  type: EventType;
  timestamp: string;
  route: string;
  release?: string;
  trace_id?: string;
  span_id?: string;
  viewport?: { width: number; height: number };
  position?: Position;
  target?: Target;
  data?: Record<string, string | number>;
}
interface Queued { sessionId: string; event: RumEvent }
interface ClickSample { at: number; key: string; x: number; y: number }
interface DeadClickCandidate {
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  position: Position;
  target: Target;
  route: string;
}
const DEAD_CLICK_WINDOW_MS = 700;
const MAX_DEAD_CLICK_CANDIDATES = 16;

function randomId(): string | undefined {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") return undefined;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function routeFrom(value: string): string | undefined {
  let pathname: string;
  try { pathname = new URL(value, window.location.href).pathname; } catch { return undefined; }
  return pathname.length <= 2048 && ROUTE.test(pathname) && !pathname.includes("//") && !pathname.includes("..") ? pathname : undefined;
}

function safeField(value: string | undefined, max = 128): string | undefined {
  return value && value.length <= max && SAFE_TEXT.test(value) ? value : undefined;
}

function unit(value: number): number | undefined {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

function positionFor(event: MouseEvent): Position | undefined {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const documentWidth = Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth);
  const documentHeight = Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight);
  if (![width, height, documentWidth, documentHeight, event.clientX, event.clientY].every(Number.isFinite) || Math.min(width, height, documentWidth, documentHeight) <= 0) return undefined;
  const values = [unit(event.clientX / width), unit(event.clientY / height), unit((event.clientX + window.scrollX) / documentWidth), unit((event.clientY + window.scrollY) / documentHeight)];
  if (values.some(value => value === undefined)) return undefined;
  return { viewport_x: values[0]!, viewport_y: values[1]!, document_x: values[2]!, document_y: values[3]! };
}

function targetFor(value: EventTarget | null): { semantic: Target; element: Element } | undefined {
  if (!(value instanceof Element)) return undefined;
  const element = value.closest("button,[role='button'],a,input,select,textarea") ?? value;
  const tag = safeField(element.tagName.toLowerCase());
  const role = safeField(element.getAttribute("role") ?? undefined);
  const testId = safeField(element.getAttribute("data-testid") ?? undefined);
  const semantic: Target = { ...(tag ? { tag } : {}), ...(role ? { role } : {}), ...(testId ? { test_id: testId } : {}) };
  return Object.keys(semantic).length ? { semantic, element } : undefined;
}

export class RumRuntime {
  private readonly queue: Queued[] = [];
  private sessionId: string;
  private lastActivity: number;
  private route: string | undefined;
  private readonly reached = new Set<number>();
  private readonly clicks: ClickSample[] = [];
  private rageTriggeredAt = -Infinity;
  private readonly pending = new Set<DeadClickCandidate>();
  private observer: MutationObserver | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private scrollTimer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | undefined;
  private stopped = false;
  private originalPush?: History["pushState"];
  private originalReplace?: History["replaceState"];
  private patchedPush?: History["pushState"];
  private patchedReplace?: History["replaceState"];

  private constructor(private readonly config: NormalizedSentinelConfig, private readonly diagnostics: SentinelDiagnostics, id: string) {
    this.sessionId = id;
    this.lastActivity = Date.now();
  }

  static start(config: NormalizedSentinelConfig, diagnostics: SentinelDiagnostics): RumRuntime | undefined {
    if (!config.rumEnabled || typeof window === "undefined" || typeof document === "undefined") return undefined;
    const id = randomId();
    if (!id) return undefined;
    const runtime = new RumRuntime(config, diagnostics, id);
    runtime.restoreSession();
    runtime.install();
    return runtime;
  }

  private restoreSession(): void {
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? "null") as { id?: unknown; at?: unknown } | null;
      if (stored && typeof stored.id === "string" && /^[a-f0-9]{32}$/.test(stored.id) && typeof stored.at === "number" && Date.now() >= stored.at && Date.now() - stored.at < RUM_INACTIVITY_MS) {
        this.sessionId = stored.id;
        this.lastActivity = stored.at;
      }
    } catch { /* Private browsing can deny storage. */ }
  }

  private touchSession(): string | undefined {
    const now = Date.now();
    if (now - this.lastActivity >= RUM_INACTIVITY_MS) {
      const id = randomId();
      if (!id) return undefined;
      this.sessionId = id;
    }
    this.lastActivity = now;
    try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: this.sessionId, at: now })); } catch { /* In-memory fallback. */ }
    return this.sessionId;
  }

  private makeEvent(type: EventType, extra: Partial<RumEvent> = {}): RumEvent | undefined {
    const route = this.route;
    if (!route || !this.touchSession()) return undefined;
    const id = randomId();
    if (!id) return undefined;
    const release = safeField(this.config.release);
    const span = trace.getSpan(context.active())?.spanContext();
    const correlation = span && isSpanContextValid(span) ? { trace_id: span.traceId.toLowerCase(), span_id: span.spanId.toLowerCase() } : {};
    const width = window.innerWidth;
    const height = window.innerHeight;
    const viewport = Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 16384 && height <= 16384 ? { width, height } : undefined;
    return { id, type, timestamp: new Date().toISOString(), route, ...(release ? { release } : {}), ...correlation, ...(viewport ? { viewport } : {}), ...extra };
  }

  private emit(type: EventType, extra: Partial<RumEvent> = {}): void {
    if (this.stopped) return;
    const event = this.makeEvent(type, extra);
    if (!event) return;
    if (this.queue.length >= RUM_QUEUE_SIZE) { this.queue.shift(); this.diagnostics.rumDrop("overflow"); }
    this.queue.push({ sessionId: this.sessionId, event });
    if (this.queue.length >= RUM_BATCH_SIZE) void this.flush();
  }

  private install(): void {
    this.route = routeFrom(window.location.href);
    this.emit("page_view");
    this.originalPush = history.pushState;
    this.originalReplace = history.replaceState;
    const onRoute = () => this.navigation();
    const push = this.originalPush;
    const replace = this.originalReplace;
    this.patchedPush = function (...args) { const result = push.apply(this, args); onRoute(); return result; };
    this.patchedReplace = function (...args) { const result = replace.apply(this, args); onRoute(); return result; };
    history.pushState = this.patchedPush;
    history.replaceState = this.patchedReplace;
    window.addEventListener("popstate", this.navigation);
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("focusin", this.onFocusResponse, true);
    this.interval = setInterval(() => { void this.flush(); }, RUM_FLUSH_INTERVAL_MS);
  }

  private readonly navigation = (): void => {
    const next = routeFrom(window.location.href);
    if (next === this.route) return;
    this.route = next;
    this.reached.clear();
    this.clicks.length = 0;
    this.rageTriggeredAt = -Infinity;
    this.cancelCandidatesAt(Date.now());
    this.emit("page_view");
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (!event.isTrusted && event.detail === 0) return;
    const position = positionFor(event);
    const target = targetFor(event.target);
    if (!position || !target) return;
    this.emit("click", { position, target: target.semantic });
    this.detectRage(position, target.semantic);
    const element = target.element;
    const eligible = (element.tagName.toLowerCase() === "button" || element.getAttribute("role") === "button") && !element.hasAttribute("disabled") && !element.closest("a,form,input,select,textarea,[contenteditable='true']");
    if (eligible) this.watchDeadClick(position, target.semantic);
  };

  private detectRage(position: Position, target: Target): void {
    const now = Date.now();
    const key = JSON.stringify(target);
    while (this.clicks.length && now - this.clicks[0]!.at > 1_000) this.clicks.shift();
    this.clicks.push({ at: now, key, x: position.viewport_x, y: position.viewport_y });
    if (this.clicks.length > 16) this.clicks.shift();
    const matches = this.clicks.filter(sample => sample.key === key && Math.hypot(sample.x - position.viewport_x, sample.y - position.viewport_y) <= 0.04);
    if (matches.length >= 3 && now - this.rageTriggeredAt > 1_000) {
      this.rageTriggeredAt = now;
      this.emit("rage_click", { position, target, data: { click_count: matches.length, duration_ms: Math.max(1, now - matches[0]!.at) } });
    }
  }

  private watchDeadClick(position: Position, target: Target): void {
    if (this.pending.size >= MAX_DEAD_CLICK_CANDIDATES || typeof MutationObserver === "undefined" || !this.route) return;
    // Deliver queued mutations to older candidates before the new click starts.
    if (this.observer?.takeRecords().length) this.cancelCandidatesAt(Date.now());
    if (!this.observer && document.body) {
      this.observer = new MutationObserver(records => {
        if (records.length) this.cancelCandidatesAt(Date.now());
      });
      this.observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    if (!this.observer) return;
    const startedAt = Date.now();
    const candidate: DeadClickCandidate = {
      startedAt,
      position,
      target,
      route: this.route,
      timer: setTimeout(() => {
        this.pending.delete(candidate);
        this.disconnectObserverIfIdle();
        if (!this.stopped && this.route === candidate.route) {
          this.emit("dead_click", { position: candidate.position, target: candidate.target });
        }
      }, DEAD_CLICK_WINDOW_MS),
    };
    this.pending.add(candidate);
  }

  private readonly onFocusResponse = (): void => {
    this.cancelCandidatesAt(Date.now());
  };

  observeFetchStart(): void {
    this.cancelCandidatesAt(Date.now());
  }

  private cancelCandidatesAt(observedAt: number): void {
    for (const candidate of this.pending) {
      const elapsed = observedAt - candidate.startedAt;
      if (elapsed < 0 || elapsed > DEAD_CLICK_WINDOW_MS) continue;
      clearTimeout(candidate.timer);
      this.pending.delete(candidate);
    }
    this.disconnectObserverIfIdle();
  }

  private disconnectObserverIfIdle(): void {
    if (this.pending.size !== 0) return;
    this.observer?.disconnect();
    this.observer = undefined;
  }

  private clearCandidates(): void {
    for (const candidate of this.pending) clearTimeout(candidate.timer);
    this.pending.clear();
    this.disconnectObserverIfIdle();
  }

  private readonly onScroll = (): void => {
    if (this.scrollTimer) return;
    this.scrollTimer = setTimeout(() => { this.scrollTimer = undefined; this.measureScroll(); }, 100);
  };

  private measureScroll(): void {
    const maximum = document.documentElement.scrollHeight - window.innerHeight;
    if (!Number.isFinite(maximum) || maximum <= 0) return;
    const depth = unit(window.scrollY / maximum);
    if (depth === undefined) return;
    for (const threshold of DEPTHS) {
      if (depth >= threshold && !this.reached.has(threshold)) {
        this.reached.add(threshold);
        this.emit("scroll_depth", { data: { depth: threshold } });
      }
    }
  }

  observeError(error: unknown, mechanism: "error" | "unhandledrejection"): void {
    this.emit("javascript_error", { data: normalizeRumError(error, mechanism) });
  }

  observeFetch(method: string, path: string, status?: number, failed = false): void {
    const route = routeFrom(path);
    if (!route || !METHODS.has(method) || path === new URL(this.config.rumUrl).pathname || Object.values(this.config.signalUrls).some(url => new URL(url).pathname === route)) return;
    if ((status !== undefined && status >= 500 && status <= 599) || (failed && (status === undefined || status === 0))) {
      this.emit("network_error", { data: { method, route, ...(status !== undefined && status >= 100 ? { status_code: status } : {}) } });
    }
  }

  async flush(keepalive = false): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.drain(keepalive).finally(() => { this.sending = undefined; });
    return this.sending;
  }

  private async drain(keepalive: boolean): Promise<void> {
    while (this.queue.length) {
      const sessionId = this.queue[0]!.sessionId;
      const batch = this.queue.splice(0, RUM_BATCH_SIZE);
      const firstDifferent = batch.findIndex(item => item.sessionId !== sessionId);
      if (firstDifferent >= 0) this.queue.unshift(...batch.splice(firstDifferent));
      const body = JSON.stringify({ schema_version: 1, session_id: sessionId, events: batch.map(item => item.event) });
      // The ingest body limit is 1 MiB; a smaller browser keepalive limit applies.
      if (body.length > (keepalive ? 60_000 : 250_000)) { this.diagnostics.rumDrop("oversize"); continue; }
      let delivered = false;
      for (let attempt = 0; attempt < (keepalive ? 1 : 2); attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        let retry: boolean;
        try {
          const response = await fetch(this.config.rumUrl, { method: "POST", headers: { Authorization: `Bearer ${this.config.publicKey}`, "Content-Type": "application/json" }, body, keepalive, signal: controller.signal });
          if (response.ok) { delivered = true; break; }
          retry = response.status === 429 || response.status >= 500;
        } catch { retry = true; }
        finally { clearTimeout(timeout); }
        if (!retry || attempt === 1 || keepalive) break;
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      if (!delivered) this.diagnostics.rumDrop("transport");
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    window.removeEventListener("popstate", this.navigation);
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("scroll", this.onScroll);
    document.removeEventListener("focusin", this.onFocusResponse, true);
    if (this.originalPush && history.pushState === this.patchedPush) history.pushState = this.originalPush;
    if (this.originalReplace && history.replaceState === this.patchedReplace) history.replaceState = this.originalReplace;
    if (this.interval) clearInterval(this.interval);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.clearCandidates();
    this.stopped = true;
    await this.flush();
  }
}
