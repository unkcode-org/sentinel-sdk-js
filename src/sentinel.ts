import { isWrapped } from "@opentelemetry/instrumentation";
import { context, SpanStatusCode } from "@opentelemetry/api";
import type {
  Counter,
  Histogram,
  Span as OpenTelemetrySpan,
} from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";

import {
  configsEquivalent,
  normalizeConfig,
  SentinelInitializationError,
} from "./config";
import { installDiagnostics } from "./diagnostics";
import type { SentinelDiagnostics } from "./diagnostics";
import type {
  NormalizedSentinelConfig,
  SentinelAttributes,
  SentinelConfig,
} from "./config";
import { createTelemetry } from "./telemetry";
import type { TelemetryRuntime } from "./telemetry";
import { registerGlobals } from "./telemetry/global-registration";
import type { GlobalRegistration } from "./telemetry/global-registration";
import { prepareFetchInstrumentation } from "./instrumentation/fetch";
import type { PreparedFetchInstrumentation } from "./instrumentation/fetch";
import { installBrowserErrorCapture } from "./instrumentation/errors";
import type { BrowserErrorCapture } from "./instrumentation/errors";
import { applyBeforeSend } from "./privacy/before-send";
import { RumRuntime } from "./rum/runtime";
import {
  redactText,
  sanitizeAttributes,
  serializeError,
} from "./privacy/sanitizer";

export interface SentinelSpan {
  setAttribute(key: string, value: unknown): this;
  addEvent(name: string, attributes?: SentinelAttributes): this;
  recordException(error: unknown): this;
  setStatus(status: "ok" | "error", message?: string): this;
  end(): void;
}

export class Sentinel {
  private shutdownPromise: Promise<void> | undefined;
  private browserErrorCapture: BrowserErrorCapture | undefined;
  private rum: RumRuntime | undefined;
  private pageLifecycleCleanup: (() => void) | undefined;
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  private constructor(
    private readonly normalizedConfig: NormalizedSentinelConfig,
    private readonly telemetry: TelemetryRuntime,
    private readonly globalRegistration: GlobalRegistration,
    private readonly fetchInstrumentation: PreparedFetchInstrumentation | undefined,
    private readonly diagnostics: SentinelDiagnostics,
  ) {}

  static init(config: SentinelConfig): Sentinel {
    const normalized = normalizeConfig(config);
    const globalState = getGlobalState();
    if (globalState.current) {
      if (configsEquivalent(globalState.current.config, normalized)) {
        return globalState.current.instance;
      }
      throw new SentinelInitializationError(
        "Sentinel is already initialized with different configuration",
      );
    }

    if (
      normalized.instrumentFetch &&
      typeof globalThis.fetch === "function" &&
      isWrapped(globalThis.fetch)
    ) {
      throw new SentinelInitializationError(
        "fetch is already instrumented; Sentinel will not install duplicate instrumentation",
      );
    }

    const diagnostics = installDiagnostics(normalized.diagnostics);
    let telemetry: TelemetryRuntime;
    try {
      telemetry = createTelemetry(normalized);
    } catch (error) {
      diagnostics.disable();
      throw error;
    }
    let globalRegistration: GlobalRegistration;
    try {
      globalRegistration = registerGlobals(telemetry.tracerProvider);
    } catch (error) {
      void telemetry.shutdown();
      diagnostics.disable();
      throw error;
    }

    const rumHolder: { current: RumRuntime | undefined } = { current: undefined };
    const fetchInstrumentation = prepareFetchInstrumentation(
      normalized,
      telemetry.tracerProvider,
      () => rumHolder.current?.onResponse(),
    );
    try {
      fetchInstrumentation?.enable();
    } catch (error) {
      globalRegistration.disable();
      void telemetry.shutdown();
      diagnostics.disable();
      throw new SentinelInitializationError(
        `Failed to enable fetch instrumentation: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    const instance = new Sentinel(
      normalized,
      telemetry,
      globalRegistration,
      fetchInstrumentation,
      diagnostics,
    );
    const rum = RumRuntime.start(normalized, diagnostics);
    rumHolder.current = rum;
    instance.rum = rum;
    telemetry.setFetchObserver((method, route, status, failed) => rum?.observeFetch(method, route, status, failed));
    if (normalized.captureErrors || rum) {
      instance.browserErrorCapture = installBrowserErrorCapture(
        (error, attributes) => {
          if (normalized.captureErrors) instance.captureException(error, attributes);
          else rum?.observeError(error, attributes?.["exception.mechanism"] === "unhandledrejection" ? "unhandledrejection" : "error");
        },
      );
    }
    instance.pageLifecycleCleanup = installPageHideFlush(instance);
    globalState.current = { config: normalized, instance };
    return instance;
  }

  debug(message: string, attributes?: SentinelAttributes): void {
    this.emitLog(SeverityNumber.DEBUG, "DEBUG", message, attributes);
  }
  info(message: string, attributes?: SentinelAttributes): void {
    this.emitLog(SeverityNumber.INFO, "INFO", message, attributes);
  }
  warn(message: string, attributes?: SentinelAttributes): void {
    this.emitLog(SeverityNumber.WARN, "WARN", message, attributes);
  }
  error(message: string, attributes?: SentinelAttributes): void {
    this.emitLog(SeverityNumber.ERROR, "ERROR", message, attributes);
  }
  fatal(message: string, attributes?: SentinelAttributes): void {
    this.emitLog(SeverityNumber.FATAL, "FATAL", message, attributes);
  }

  captureException(error: unknown, attributes?: SentinelAttributes): void {
    const exception = serializeError(error);
    this.emitLog(SeverityNumber.ERROR, "ERROR", exception.message, {
      ...attributes,
      "exception.type": exception.type,
      "exception.message": exception.message,
      ...(exception.stack ? { "exception.stacktrace": exception.stack } : {}),
    });
    this.rum?.observeError(error, attributes?.["exception.mechanism"] === "unhandledrejection" ? "unhandledrejection" : "error");
  }

  startSpan(name: string, attributes?: SentinelAttributes): SentinelSpan {
    const draft = applyBeforeSend(this.normalizedConfig, {
      signal: "span",
      name,
      attributes: sanitizeAttributes(attributes),
    }, this.diagnostics);
    if (draft === null) return NOOP_SPAN;
    return new SentinelSpanFacade(
      this.telemetry.tracer.startSpan(draft.name, {
        attributes: draft.attributes,
      }),
    );
  }

  startActiveSpan<T>(
    name: string,
    callback: (span: SentinelSpan) => T,
    attributes?: SentinelAttributes,
  ): T {
    const draft = applyBeforeSend(this.normalizedConfig, {
      signal: "span",
      name,
      attributes: sanitizeAttributes(attributes),
    }, this.diagnostics);
    if (draft === null) return callback(NOOP_SPAN);

    const run = (span: OpenTelemetrySpan): T => {
      const facade = new SentinelSpanFacade(span);
      try {
        const result = callback(facade);
        if (isPromiseLike(result)) {
          return result.then(
            value => {
              span.end();
              return value;
            },
            error => {
              facade.recordException(error).setStatus("error");
              span.end();
              throw error;
            },
          ) as T;
        }
        span.end();
        return result;
      } catch (error) {
        facade.recordException(error).setStatus("error");
        span.end();
        throw error;
      }
    };
    return this.telemetry.tracer.startActiveSpan(
      draft.name,
      { attributes: draft.attributes },
      run,
    );
  }

  counter(name: string, value = 1, attributes?: SentinelAttributes): void {
    if (!Number.isFinite(value)) return;
    const draft = this.metricDraft(name, attributes);
    if (draft === null) return;
    const instrumentName = normalizeInstrumentName(draft.name);
    let counter = this.counters.get(instrumentName);
    if (counter === undefined) {
      counter = this.telemetry.meter.createCounter(instrumentName);
      this.counters.set(instrumentName, counter);
    }
    counter.add(value, draft.attributes);
  }

  histogram(name: string, value: number, attributes?: SentinelAttributes): void {
    if (!Number.isFinite(value)) return;
    const draft = this.metricDraft(name, attributes);
    if (draft === null) return;
    const instrumentName = normalizeInstrumentName(draft.name);
    let histogram = this.histograms.get(instrumentName);
    if (histogram === undefined) {
      histogram = this.telemetry.meter.createHistogram(instrumentName);
      this.histograms.set(instrumentName, histogram);
    }
    histogram.record(value, draft.attributes);
  }

  async flush(): Promise<void> {
    await Promise.all([this.telemetry.flush(), this.rum?.flush()]);
  }

  flushLifecycle(): void {
    void this.telemetry.flush().catch(() => this.diagnostics.lifecycleFailure());
    void this.rum?.flush(true);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    try {
      this.browserErrorCapture?.disable();
      this.pageLifecycleCleanup?.();
      this.telemetry.setFetchObserver(undefined);
      await this.rum?.shutdown();
      this.fetchInstrumentation?.disable();
      await this.telemetry.shutdown();
    } finally {
      this.globalRegistration.disable();
      this.diagnostics.disable();
      const globalState = getGlobalState();
      if (globalState.current?.instance === this) {
        delete globalState.current;
      }
    }
  }

  private emitLog(
    severityNumber: SeverityNumber,
    severityText: string,
    message: string,
    attributes?: SentinelAttributes,
  ): void {
    const draft = applyBeforeSend(this.normalizedConfig, {
      signal: "log",
      name: severityText.toLowerCase(),
      body: message,
      attributes: sanitizeAttributes(attributes),
    }, this.diagnostics);
    if (draft === null) return;
    this.telemetry.logger.emit({
      context: context.active(),
      severityNumber,
      severityText,
      body: draft.body ?? "",
      attributes: draft.attributes,
    });
  }

  private metricDraft(name: string, attributes?: SentinelAttributes) {
    return applyBeforeSend(this.normalizedConfig, {
      signal: "metric",
      name,
      attributes: sanitizeAttributes(attributes),
    }, this.diagnostics);
  }
}

function installPageHideFlush(
  sentinel: Sentinel,
): (() => void) | undefined {
  if (typeof globalThis.addEventListener !== "function") return undefined;
  const onPageHide = () => {
    sentinel.flushLifecycle();
  };
  globalThis.addEventListener("pagehide", onPageHide);
  return () => globalThis.removeEventListener("pagehide", onPageHide);
}

class SentinelSpanFacade implements SentinelSpan {
  constructor(private readonly span: OpenTelemetrySpan) {}

  setAttribute(key: string, value: unknown): this {
    const attributes = sanitizeAttributes({ [key]: value });
    const sanitized = attributes[key];
    if (sanitized !== undefined) this.span.setAttribute(key, sanitized);
    return this;
  }

  addEvent(name: string, attributes?: SentinelAttributes): this {
    this.span.addEvent(redactText(name), sanitizeAttributes(attributes));
    return this;
  }

  recordException(error: unknown): this {
    const exception = serializeError(error);
    this.span.recordException({
      name: exception.type,
      message: exception.message,
      ...(exception.stack ? { stack: exception.stack } : {}),
    });
    return this;
  }

  setStatus(status: "ok" | "error", message?: string): this {
    this.span.setStatus({
      code: status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      ...(message === undefined ? {} : { message: redactText(message) }),
    });
    return this;
  }

  end(): void {
    this.span.end();
  }
}

const NOOP_SPAN: SentinelSpan = {
  setAttribute() {
    return this;
  },
  addEvent() {
    return this;
  },
  recordException() {
    return this;
  },
  setStatus() {
    return this;
  },
  end() {},
};

function isPromiseLike<T>(value: T): value is T & PromiseLike<Awaited<T>> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function normalizeInstrumentName(name: string): string {
  const normalized = redactText(name)
    .replace(/[^A-Za-z0-9_.\-/]/g, "_")
    .slice(0, 255);
  return /^[A-Za-z]/.test(normalized) ? normalized : `sentinel.${normalized}`;
}

interface SentinelGlobalState {
  current?: {
    readonly config: NormalizedSentinelConfig;
    readonly instance: Sentinel;
  };
}

const GLOBAL_STATE_KEY = Symbol.for("@unkcode/sentinel/v0.1.0");

function getGlobalState(): SentinelGlobalState {
  const target = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: SentinelGlobalState;
  };
  target[GLOBAL_STATE_KEY] ??= {};
  return target[GLOBAL_STATE_KEY];
}
