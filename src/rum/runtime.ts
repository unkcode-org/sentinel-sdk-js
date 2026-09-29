import { context, isSpanContextValid, trace } from "@opentelemetry/api";
import type { NormalizedSentinelConfig } from "../config";
import type { SentinelDiagnostics } from "../diagnostics";
import { normalizeRumError } from "./normalize-error";
import { attemptTargetFor, targetFor, type Target } from "./target";

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
interface AttemptSample { at: number; element: Element; x: number; y: number }
interface PointerPress { element: Element; parent: Element | null; source: Element; sourceParent: Element | null; route: string; at: number; x: number; y: number; timer?: ReturnType<typeof setTimeout> }
interface PendingAttempt { element: Element; parent: Element | null; source: Element; sourceParent: Element | null; at: number; x: number; y: number; position: Position; timer: ReturnType<typeof setTimeout> }
interface DeadClickCandidate {
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  position: Position;
  target: Target;
  route: string;
}
const DEAD_CLICK_WINDOW_MS = 700;
const MAX_DEAD_CLICK_CANDIDATES = 16;
const MAX_POINTER_PRESSES = 8;
const MAX_PENDING_ATTEMPTS = 16;
const MAX_PRESS_MS = 750;
const MAX_MOVE_PX = 10;
// Measured pointerup→click maxima: Chromium 2.3 ms, Firefox 10 ms, WebKit 2 ms.
const CLICK_CORRELATION_MS = 32;

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

export class RumRuntime {
  private readonly queue: Queued[] = [];
  private sessionId: string;
  private lastActivity: number;
  private route: string | undefined;
  private readonly reached = new Set<number>();
  private readonly rageAttempts: AttemptSample[] = [];
  private readonly presses = new Map<number, PointerPress>();
  private readonly attempts = new Set<PendingAttempt>();
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
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("pointermove", this.onPointerMove, { capture: true, passive: true });
    document.addEventListener("pointerup", this.onPointerUp, true);
    document.addEventListener("pointercancel", this.onPointerCancel, true);
    document.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("focusin", this.onFocusResponse, true);
    this.interval = setInterval(() => { void this.flush(); }, RUM_FLUSH_INTERVAL_MS);
  }

  private readonly navigation = (): void => {
    const next = routeFrom(window.location.href);
    if (next === this.route) return;
    this.route = next;
    this.reached.clear();
    this.rageAttempts.length = 0;
    this.rageTriggeredAt = -Infinity;
    this.clearPointerState();
    this.cancelCandidatesAt(Date.now());
    this.emit("page_view");
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (!event.isTrusted && event.detail === 0) return;
    const position = positionFor(event);
    const target = targetFor(event.target);
    if (!position || !target) return;
    const logical = attemptTargetFor(event.target);
    if (event.isTrusted && event.detail > 0 && logical) this.consumeAttempt(logical.element, event.clientX, event.clientY);
    this.emit("click", { position, target: target.semantic });
    this.detectRage(position, logical?.semantic ?? target.semantic, logical?.element ?? target.element);
    if (target.deadEligible) this.watchDeadClick(position, target.semantic);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    if (event.pointerType === "touch" && !event.isPrimary) { this.clearPresses(); return; }
    if (!event.isPrimary || event.button !== 0 || !this.route || !(event.target instanceof Element)) return;
    const target = attemptTargetFor(event.target);
    if (!target || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    if (this.presses.size >= MAX_POINTER_PRESSES) this.deletePress(this.presses.keys().next().value!);
    this.deletePress(event.pointerId);
    const press: PointerPress = { element: target.element, parent: target.element.parentElement,
      source: event.target, sourceParent: event.target.parentElement, route: this.route,
      at: Date.now(), x: event.clientX, y: event.clientY };
    press.timer = setTimeout(() => { if (this.presses.get(event.pointerId) === press) this.deletePress(event.pointerId); }, MAX_PRESS_MS);
    this.presses.set(event.pointerId, press);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    const press = this.presses.get(event.pointerId);
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MAX_MOVE_PX) this.deletePress(event.pointerId);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => { if (event.isTrusted) this.deletePress(event.pointerId); };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const press = this.presses.get(event.pointerId);
    if (!press) return;
    this.deletePress(event.pointerId);
    const at = Date.now();
    if (!event.isTrusted || !event.isPrimary || event.button !== 0 || at - press.at > MAX_PRESS_MS ||
      at < press.at || this.route !== press.route || !press.element.isConnected ||
      press.element.parentElement !== press.parent || press.source.parentElement !== press.sourceParent ||
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > MAX_MOVE_PX) return;
    const target = attemptTargetFor(event.target);
    const position = positionFor(event);
    if (!target || target.element !== press.element || !position) return;
    if (this.attempts.size >= MAX_PENDING_ATTEMPTS) {
      const oldest = this.attempts.values().next().value;
      if (oldest) { clearTimeout(oldest.timer); this.attempts.delete(oldest); }
    }
    const attempt: PendingAttempt = { element: press.element, parent: press.parent,
      source: press.source, sourceParent: press.sourceParent, at, x: event.clientX, y: event.clientY,
      position, timer: setTimeout(() => {
        this.attempts.delete(attempt);
        if (this.stopped || this.route !== press.route || !attempt.element.isConnected ||
          attempt.element.parentElement !== attempt.parent || attempt.source.parentElement !== attempt.sourceParent) return;
        const current = attemptTargetFor(attempt.source);
        if (current?.element === attempt.element) this.detectRage(attempt.position, current.semantic, current.element, attempt.at);
      }, CLICK_CORRELATION_MS) };
    this.attempts.add(attempt);
  };

  private consumeAttempt(element: Element, x: number, y: number): void {
    const now = Date.now();
    const matches = Array.from(this.attempts).filter(attempt => attempt.element === element &&
      now >= attempt.at && now - attempt.at <= CLICK_CORRELATION_MS &&
      Math.hypot(x - attempt.x, y - attempt.y) <= MAX_MOVE_PX);
    // Ambiguous pairing is omitted, so a click cannot be counted twice.
    for (const attempt of matches) {
      clearTimeout(attempt.timer);
      this.attempts.delete(attempt);
    }
  }

  private clearPointerState(): void {
    this.clearPresses();
    for (const attempt of this.attempts) clearTimeout(attempt.timer);
    this.attempts.clear();
  }

  private deletePress(id: number): void {
    const press = this.presses.get(id);
    if (press?.timer) clearTimeout(press.timer);
    this.presses.delete(id);
  }

  private clearPresses(): void {
    for (const id of this.presses.keys()) this.deletePress(id);
  }

  private detectRage(position: Position, target: Target, element: Element, at = Date.now()): void {
    const now = Date.now();
    while (this.rageAttempts.length && now - this.rageAttempts[0]!.at > 1_000 + CLICK_CORRELATION_MS) this.rageAttempts.shift();
    this.rageAttempts.push({ at, element, x: position.viewport_x, y: position.viewport_y });
    if (this.rageAttempts.length > 16) this.rageAttempts.shift();
    const own = this.rageAttempts.filter(sample => sample.element === element);
    const latest = own.reduce((best, sample) => sample.at > best.at ? sample : best, own[0]!);
    const matches = this.rageAttempts.filter(sample => sample.element === element && latest.at - sample.at <= 1_000 &&
      Math.hypot(sample.x - latest.x, sample.y - latest.y) <= 0.04).sort((a, b) => a.at - b.at);
    if (matches.length >= 3 && now - this.rageTriggeredAt > 1_000) {
      this.rageTriggeredAt = now;
      this.emit("rage_click", { position, target, data: { click_count: matches.length, duration_ms: Math.max(1, latest.at - matches[0]!.at) } });
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
    this.clearPresses();
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
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("pointermove", this.onPointerMove, true);
    document.removeEventListener("pointerup", this.onPointerUp, true);
    document.removeEventListener("pointercancel", this.onPointerCancel, true);
    document.removeEventListener("scroll", this.onScroll);
    document.removeEventListener("focusin", this.onFocusResponse, true);
    if (this.originalPush && history.pushState === this.patchedPush) history.pushState = this.originalPush;
    if (this.originalReplace && history.replaceState === this.patchedReplace) history.replaceState = this.originalReplace;
    if (this.interval) clearInterval(this.interval);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.clearCandidates();
    this.clearPointerState();
    this.rageAttempts.length = 0;
    this.stopped = true;
    await this.flush();
  }
}
