import type { NormalizedSentinelConfig } from "../config";
import type { SentinelDiagnostics } from "../diagnostics";
import type { RumRuntime } from "../rum/runtime";
import { discoverReplayPolicy, type ReplayPolicy } from "./policy";
import { sanitizeReplayEvent, type SafeReplayEvent } from "./privacy";

type TriggerType = "javascript_error" | "network_error" | "rage_click" | "dead_click";
export type ReplayState = "checking-policy" | "buffering" | "promoting" | "promoted" | "disabled-by-policy" | "unsupported" | "privacy-blocked" | "limit-reached" | "upload-failed" | "page-ended" | "destroyed";
type State = ReplayState;
interface Group { events: SafeReplayEvent[]; bytes: number; started: number }
interface PendingChunk { body: string; decodedEvents: number; sequence: number }
interface Continuity {
  session: string; credentialHash: string; replay: string; triggerType: TriggerType; triggerId: string;
  started: number; chunks: number; pages: number; decoded: number; until: number;
}

const CONTINUITY_KEY = "@unkcode/sentinel/replay-continuity-v1";
const PRE_MS = 30_000;
const PRE_BYTES = 2 << 20;
const PRE_EVENTS = 5000;
const encoder = new TextEncoder();
const EVENT_TYPES = new Set<TriggerType>(["javascript_error", "network_error", "rage_click", "dead_click"]);
const retryable = new Set([429, 500, 503]);
const BLOCK_SELECTOR = '[data-sentinel-private],iframe,frame,canvas,video,audio,script,style,object,embed,svg,link,meta,input,textarea,select,option,picture,source,track,template,noscript,[contenteditable]';

function uuid(): string | undefined {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues !== "function") return undefined;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function credentialHash(key: string, endpoint: string, origin: string): Promise<string | undefined> {
  if (!crypto.subtle) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${key}\0${endpoint}\0${origin}`));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("");
}
function readContinuity(): Continuity | undefined {
  try {
    const raw = sessionStorage.getItem(CONTINUITY_KEY);
    if (!raw || raw.length > 1024) return undefined;
    const item = JSON.parse(raw) as Partial<Continuity>;
    if (typeof item.session !== "string" || !/^[a-f0-9]{32}$/.test(item.session) ||
      typeof item.credentialHash !== "string" || !/^[a-f0-9]{64}$/.test(item.credentialHash) ||
      typeof item.replay !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.replay) ||
      typeof item.triggerId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.triggerId) ||
      !EVENT_TYPES.has(item.triggerType as TriggerType) ||
      !Number.isFinite(item.started) || (item.started as number) > Date.now() + 5 * 60_000 || Date.now() - (item.started as number) > 900_000 ||
      !Number.isInteger(item.chunks) || !Number.isInteger(item.pages) || !Number.isInteger(item.decoded) ||
      !Number.isFinite(item.until) || Date.now() >= (item.until as number) || item.chunks! < 1 || item.chunks! > 64 ||
      item.pages! < 1 || item.pages! > 16 || item.decoded! < 1 || item.decoded! > (16 << 20)) return undefined;
    return item as Continuity;
  } catch { return undefined; }
}
function clearContinuity(): void { try { sessionStorage.removeItem(CONTINUITY_KEY); } catch { /* storage denied */ } }
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", done); clearTimeout(timer); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class ReplayRuntime {
  private state: State = "checking-policy";
  private policy: ReplayPolicy | undefined;
  private authorityDeadline = 0;
  private readonly abort = new AbortController();
  private requestAbort: AbortController | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private postTimer: ReturnType<typeof setTimeout> | undefined;
  private stopRecorder: (() => void) | undefined;
  private privateMarkerObserver: MutationObserver | undefined;
  private generation = 0;
  private groups: Group[] = [];
  private pendingMeta: SafeReplayEvent | undefined;
  private blockedIds = new Set<number>();
  private privateNodeForId: ((id: number) => boolean) | undefined;
  private post: SafeReplayEvent[] = [];
  private postBytes = 0;
  private queue: PendingChunk[] = [];
  private sending: Promise<void> | undefined;
  private promotion: Promise<void> | undefined;
  private replayId: string | undefined;
  private sessionId: string;
  private pageId: string | undefined;
  private trigger: { type: TriggerType; event_id: string } | undefined;
  private sequence = 0;
  private chunks = 0;
  private pages = 0;
  private decoded = 0;
  private started = 0;
  private continuity: Continuity | undefined;
  private hash: string | undefined;

  private constructor(private readonly config: NormalizedSentinelConfig, private readonly rum: RumRuntime, private readonly diagnostics: SentinelDiagnostics) {
    this.sessionId = rum.currentSessionId();
  }

  static start(config: NormalizedSentinelConfig, rum: RumRuntime | undefined, diagnostics: SentinelDiagnostics): ReplayRuntime | undefined {
    if (!config.replayEnabled || !rum || typeof document === "undefined" || typeof window === "undefined" || !globalThis.crypto) return undefined;
    const runtime = new ReplayRuntime(config, rum, diagnostics);
    rum.setReplayTriggerObserver((type, eventId, sessionId) => runtime.promoteTrigger(type, eventId, sessionId));
    void runtime.initialize();
    return runtime;
  }

  get status(): State { return this.state; }

  private async initialize(): Promise<void> {
    try {
      this.hash = await credentialHash(this.config.publicKey, this.config.endpoint, window.location.origin);
      const saved = readContinuity();
      clearContinuity();
      if (saved && this.hash === saved.credentialHash && saved.session === this.sessionId) this.continuity = saved;
      await this.refresh();
    } catch { this.stop("disabled-by-policy"); }
  }

  private async refresh(): Promise<void> {
    if (this.abort.signal.aborted || this.terminal()) return;
    const controller = new AbortController();
    this.requestAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 4000);
    let next: ReplayPolicy | null = null;
    try { next = await discoverReplayPolicy(this.config, controller.signal); } catch { /* fail closed */ }
    finally { clearTimeout(timeout); if (this.requestAbort === controller) this.requestAbort = undefined; }
    if (this.abort.signal.aborted || this.terminal()) return;
    if (!next) { this.stop("disabled-by-policy"); return; }
    this.policy = next;
    this.authorityDeadline = performance.now() + Math.max(0, next.expiresAt - Date.now());
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      if (this.policy === next) this.stop("disabled-by-policy");
    }, Math.max(0, this.authorityDeadline - performance.now()));
    if (this.state === "checking-policy") {
      if (this.continuity) {
        const old = this.continuity;
        if (old.chunks >= next.limits.max_chunks_per_replay || old.pages >= next.limits.max_pages_per_replay ||
            old.decoded >= next.limits.max_decoded_replay_bytes || Date.now() - old.started >= next.limits.max_promoted_duration_seconds * 1000) {
          this.stop("limit-reached"); return;
        }
        this.replayId = old.replay;
        this.trigger = { type: old.triggerType, event_id: old.triggerId };
        this.chunks = old.chunks; this.pages = old.pages; this.decoded = old.decoded; this.started = old.started;
        this.state = "promoted";
      } else this.state = "buffering";
      await this.startRecorder();
    } else if (this.chunks >= next.limits.max_chunks_per_replay || this.pages > next.limits.max_pages_per_replay ||
      this.decoded >= next.limits.max_decoded_replay_bytes ||
      this.queue.some(chunk => encoder.encode(chunk.body).byteLength > Math.min(next.limits.max_wire_request_bytes, next.limits.max_decoded_request_bytes)) ||
      this.queue.some(chunk => JSON.parse(chunk.body).event_count > next.limits.max_events_per_chunk) ||
      this.started && Date.now() - this.started >= next.limits.max_promoted_duration_seconds * 1000) {
      this.stop("limit-reached"); return;
    }
    if (!this.terminal() && !this.abort.signal.aborted) this.pollTimer = setTimeout(() => { void this.refresh(); }, 2500);
  }

  private async startRecorder(): Promise<void> {
    const generation = ++this.generation;
    try {
      const { record } = await import("rrweb");
      if (this.abort.signal.aborted || this.terminal() || generation !== this.generation || !this.authorized()) return;
      const page = uuid();
      if (!page) { this.stop("unsupported"); return; }
      this.pageId = page;
      this.pages++;
      const stop = record({
        emit: event => this.onEvent(event),
        checkoutEveryNms: 9000, checkoutEveryNth: 900,
        blockSelector: BLOCK_SELECTOR,
        maskAllInputs: true, maskTextSelector: "*", maskTextFn: () => "*",
        recordCanvas: false, recordCrossOriginIframes: false, inlineImages: false, inlineStylesheet: false, collectFonts: false,
        plugins: [],
        errorHandler: () => { this.stop("privacy-blocked"); return true; },
      });
      if (!stop) { this.stop("unsupported"); return; }
      if (this.terminal()) { stop(); return; }
      this.stopRecorder = stop;
      // rrweb can suppress the attribute mutation that turns an already captured
      // subtree private. Observe that transition independently and discard the
      // local replay before any subsequent mutation can be retained.
      this.privateMarkerObserver = new MutationObserver(records => {
        if (records.length) this.stop("privacy-blocked");
      });
      this.privateMarkerObserver.observe(document.documentElement, {
        attributes: true, attributeFilter: ["data-sentinel-private"], subtree: true,
      });
      this.privateNodeForId = id => {
        const node = record.mirror.getNode(id);
        if (node && typeof ShadowRoot !== "undefined" && node.getRootNode() instanceof ShadowRoot) return true;
        const element = node instanceof Element ? node : node?.parentElement;
        return !!element?.closest(BLOCK_SELECTOR);
      };
    } catch { this.stop("unsupported"); }
  }

  private authorized(): boolean { return !!this.policy && performance.now() < this.authorityDeadline; }
  private terminal(): boolean { return ["privacy-blocked", "limit-reached", "upload-failed", "page-ended", "destroyed", "unsupported", "disabled-by-policy"].includes(this.state); }

  private onEvent(raw: unknown): void {
    if (this.sessionId !== this.rum.currentSessionId()) { clearContinuity(); this.stop("page-ended"); return; }
    if (!this.authorized()) { this.stop("disabled-by-policy"); return; }
    if (this.state !== "buffering" && this.state !== "promoted" && this.state !== "promoting") return;
    const event = sanitizeReplayEvent(raw, this.blockedIds, this.privateNodeForId);
    if (!event) return;
    const bytes = encoder.encode(JSON.stringify(event)).byteLength;
    if (bytes > Math.min(this.policy!.limits.max_wire_request_bytes, this.policy!.limits.max_decoded_request_bytes) - 512) {
      this.stop("limit-reached"); return;
    }
    if (this.state === "buffering") {
      if (event.type === 4) { this.pendingMeta = event; return; }
      if (event.type === 2) {
        if (!this.pendingMeta) { this.stop("privacy-blocked"); return; }
        const anchor = [this.pendingMeta, event];
        this.pendingMeta = undefined;
        this.groups.push({ events: anchor, bytes: anchor.reduce((n, e) => n + encoder.encode(JSON.stringify(e)).byteLength, 0), started: anchor[0]!.timestamp });
      } else if (this.groups.length) {
        const group = this.groups.at(-1)!;
        group.events.push(event); group.bytes += bytes;
      }
      this.evict();
      return;
    }
    this.post.push(event); this.postBytes += bytes;
    if (this.postBytes > 512_000 || this.queue.length >= 4) { this.stop("limit-reached"); return; }
    if (this.postBytes >= 32_000) this.sealPost();
    else if (!this.postTimer) this.postTimer = setTimeout(() => { this.postTimer = undefined; this.sealPost(); }, 2000);
  }

  private evict(): void {
    const total = () => ({ bytes: this.groups.reduce((n, group) => n + group.bytes, 0), count: this.groups.reduce((n, group) => n + group.events.length, 0) });
    while (this.groups.length > 1) {
      const { bytes, count } = total();
      if (bytes <= PRE_BYTES && count <= PRE_EVENTS && Date.now() - this.groups[0]!.started <= PRE_MS) break;
      this.groups.shift();
    }
    const { bytes, count } = total();
    if (bytes > PRE_BYTES || count > PRE_EVENTS || this.groups.length && Date.now() - this.groups[0]!.started > PRE_MS + 10_000) this.stop("limit-reached");
  }

  private promoteTrigger(type: TriggerType, eventId: string, sessionId: string): void {
    if (this.state !== "buffering" || !this.authorized() || sessionId !== this.sessionId || !this.groups.length) return;
    this.evict();
    if (this.state !== "buffering" || !this.groups.length) return;
    const replay = uuid();
    if (!replay) { this.stop("unsupported"); return; }
    this.replayId = replay;
    this.trigger = { type, event_id: eventId };
    this.started = this.groups[0]!.started;
    this.state = "promoting";
    const events = this.groups.flatMap(group => group.events);
    this.groups = [];
    this.promotion = this.promote(events);
  }

  private async promote(events: SafeReplayEvent[]): Promise<void> {
    let cursor = 0;
    while (cursor < events.length && this.state === "promoting") {
      const batch: SafeReplayEvent[] = [];
      let bytes = 0;
      while (cursor < events.length && batch.length < 100) {
        const candidate = events[cursor]!;
        const size = encoder.encode(JSON.stringify(candidate)).byteLength + 1;
        if (batch.length && bytes + size > this.eventBudget()) break;
        batch.push(candidate); bytes += size; cursor++;
      }
      if (!batch.length || !this.seal(batch, false)) return;
      await wait(0, this.abort.signal);
    }
    if (this.state === "promoting") { this.state = "promoted"; this.sealPost(); }
  }

  private fits(events: SafeReplayEvent[]): boolean {
    const limit = this.policy?.limits;
    if (!limit || events.length > limit.max_events_per_chunk) return false;
    return encoder.encode(this.body(events, this.sequence, false)).byteLength <= Math.floor(Math.min(limit.max_wire_request_bytes, limit.max_decoded_request_bytes) * 0.9);
  }

  private eventBudget(): number {
    const limits = this.policy?.limits;
    return limits ? Math.floor(Math.min(limits.max_wire_request_bytes, limits.max_decoded_request_bytes) * 0.9) - 1024 : 0;
  }

  private body(events: SafeReplayEvent[], sequence: number, final: boolean): string {
    return JSON.stringify({ schema_version: 1, session_id: this.sessionId, replay_id: this.replayId,
      page_id: this.pageId, sequence, recorder: "rrweb", recorder_version: "2.1.6",
      started_at: new Date(events[0]!.timestamp).toISOString(), ended_at: new Date(events.at(-1)!.timestamp).toISOString(),
      event_count: events.length, events, final, truncated: false,
      ...(sequence === 0 && this.chunks === 0 && this.trigger ? { trigger: this.trigger } : {}) });
  }

  private seal(events: SafeReplayEvent[], final: boolean): boolean {
    const limit = this.policy?.limits;
    if (!limit || !events.length || !this.authorized() || !this.fits(events) || !this.pageId || !this.replayId ||
      this.sequence > 63 || this.chunks >= limit.max_chunks_per_replay || this.pages > limit.max_pages_per_replay ||
      events.at(-1)!.timestamp - this.started > limit.max_promoted_duration_seconds * 1000) { this.stop("limit-reached"); return false; }
    if (this.sequence === 0 && (events[0]?.type !== 4 || events[1]?.type !== 2)) { this.stop("privacy-blocked"); return false; }
    const body = this.body(events, this.sequence, final);
    const decodedEvents = encoder.encode(JSON.stringify(events)).byteLength;
    if (this.decoded + decodedEvents > limit.max_decoded_replay_bytes || this.queue.length >= 4) { this.stop("limit-reached"); return false; }
    this.queue.push({ body, decodedEvents, sequence: this.sequence });
    this.sequence++; this.chunks++; this.decoded += decodedEvents;
    void this.drain();
    return true;
  }

  private sealPost(): void {
    if (this.state !== "promoted" || !this.post.length) return;
    while (this.post.length && this.state === "promoted") {
      const batch: SafeReplayEvent[] = [];
      let bytes = 0;
      while (this.post.length && batch.length < 100) {
        const size = encoder.encode(JSON.stringify(this.post[0]!)).byteLength + 1;
        if (bytes + size > this.eventBudget()) break;
        batch.push(this.post.shift()!); bytes += size;
      }
      if (!batch.length) { this.stop("limit-reached"); return; }
      this.postBytes -= batch.reduce((n, event) => n + encoder.encode(JSON.stringify(event)).byteLength, 0);
      if (!this.seal(batch, false)) return;
    }
  }

  private async drain(): Promise<void> {
    if (this.sending || !this.queue.length) return;
    this.sending = this.sendAll().finally(() => { this.sending = undefined; });
    await this.sending;
  }

  private async sendAll(): Promise<void> {
    while (this.queue.length && this.authorized() && !this.terminal()) {
      if (this.sessionId !== this.rum.currentSessionId()) { clearContinuity(); this.stop("page-ended"); return; }
      const chunk = this.queue[0]!;
      let accepted = false;
      for (let attempt = 0; attempt < 3 && !accepted && !this.abort.signal.aborted; attempt++) {
        const controller = new AbortController();
        this.requestAbort = controller;
        const timeout = setTimeout(() => controller.abort(), 12_000);
        let status: number;
        let retryAfter = 0;
        try {
          const response = await fetch(this.config.replayChunksUrl, { method: "POST", headers: {
            Authorization: `Bearer ${this.config.publicKey}`, "Content-Type": "application/json",
          }, body: chunk.body, redirect: "error", signal: controller.signal });
          status = response.status;
          if (status === 202) {
            const text = await response.text();
            const value = text.length <= 128 ? JSON.parse(text) as { accepted?: unknown; duplicate?: unknown } : {};
            accepted = value.accepted === true && typeof value.duplicate === "boolean";
          }
          if (retryable.has(status)) {
            const raw = response.headers.get("retry-after");
            const seconds = raw && /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
            retryAfter = Math.min(5000, seconds * 1000);
          }
        } catch { status = 0; }
        finally { clearTimeout(timeout); if (this.requestAbort === controller) this.requestAbort = undefined; }
        if (accepted) break;
        if (status && !retryable.has(status)) { this.stop(status === 401 || status === 403 ? "disabled-by-policy" : "upload-failed"); return; }
        if (attempt < 2 && this.authorized()) await wait(Math.max(retryAfter, (250 * 2 ** attempt) + Math.random() * 250), this.abort.signal);
      }
      if (!accepted) { this.stop("upload-failed"); return; }
      if (this.terminal()) return;
      this.queue.shift();
      this.saveContinuity();
    }
  }

  private saveContinuity(): void {
    if (!this.hash || !this.replayId || !this.trigger || !this.queue.length && this.chunks < 1) return;
    // Only accepted contiguous chunks count toward a document handoff.
    const acceptedChunks = this.chunks - this.queue.length;
    const acceptedDecoded = this.decoded - this.queue.reduce((n, item) => n + item.decodedEvents, 0);
    if (acceptedChunks < 1) return;
    try { sessionStorage.setItem(CONTINUITY_KEY, JSON.stringify({
      session: this.sessionId, credentialHash: this.hash, replay: this.replayId,
      triggerType: this.trigger.type, triggerId: this.trigger.event_id, started: this.started,
      chunks: acceptedChunks, pages: this.pages, decoded: acceptedDecoded,
      until: Math.min(this.started + 15 * 60_000, Date.now() + 60_000),
    } satisfies Continuity)); } catch { /* no cross-document continuation */ }
  }

  private stop(state: State): void {
    if (this.terminal() && state !== "destroyed" && state !== "page-ended") return;
    this.state = state; this.generation++;
    this.privateMarkerObserver?.disconnect(); this.privateMarkerObserver = undefined;
    this.stopRecorder?.(); this.stopRecorder = undefined;
    this.requestAbort?.abort(); this.requestAbort = undefined;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.postTimer) clearTimeout(this.postTimer);
    this.groups = []; this.post = []; this.queue = []; this.blockedIds.clear(); this.pendingMeta = undefined;
    if (state !== "page-ended" && state !== "destroyed") clearContinuity();
    if (state !== "checking-policy" && state !== "buffering" && state !== "promoting" && state !== "promoted") this.diagnostics.replayOutcome(state);
    if (state === "disabled-by-policy" && !this.replayId && !this.abort.signal.aborted) {
      this.pollTimer = setTimeout(() => { this.state = "checking-policy"; void this.refresh(); }, 5000);
    }
  }

  pagehide(): void {
    if (this.state === "promoted" || this.state === "promoting") this.saveContinuity();
    this.stop("page-ended");
  }
  async flush(): Promise<void> { await this.promotion; this.sealPost(); await this.sending; }
  shutdown(): void {
    this.rum.setReplayTriggerObserver(undefined);
    this.abort.abort(); this.stop("destroyed");
    clearContinuity();
  }
}
