import { diag, DiagLogLevel } from "@opentelemetry/api";
import type { DiagLogFunction, DiagLogger } from "@opentelemetry/api";

const MAX_MESSAGES_PER_LEVEL = 5;

export interface SentinelDiagnostics {
  beforeSendFailure(): void;
  lifecycleFailure(): void;
  rumDrop(reason: "overflow" | "oversize" | "transport"): void;
  disable(): void;
}

export function installDiagnostics(enabled: boolean): SentinelDiagnostics {
  if (!enabled) return NOOP_DIAGNOSTICS;

  const counts = new Map<string, number>();
  const emit = (level: "error" | "warn" | "info" | "debug"): DiagLogFunction =>
    () => {
      const count = counts.get(level) ?? 0;
      if (count >= MAX_MESSAGES_PER_LEVEL) return;
      counts.set(level, count + 1);
      // Deliberately discard upstream messages and arguments: diagnostics can
      // contain transport errors with URLs, headers, or payload fragments.
      console[level](`[Sentinel/OpenTelemetry] ${level}`);
    };

  const logger: DiagLogger = {
    error: emit("error"),
    warn: emit("warn"),
    info: emit("info"),
    debug: emit("debug"),
    verbose: () => undefined,
  };
  const installed = diag.setLogger(logger, {
    logLevel: DiagLogLevel.WARN,
    suppressOverrideMessage: true,
  });

  let active = installed;
  const rumDrops = new Map<string, number>();
  return {
    beforeSendFailure() {
      if (active) logger.warn("beforeSend failed");
    },
    lifecycleFailure() {
      if (active) logger.warn("lifecycle operation failed");
    },
    rumDrop(reason) {
      if (!active) return;
      const count = rumDrops.get(reason) ?? 0;
      if (count >= MAX_MESSAGES_PER_LEVEL) return;
      rumDrops.set(reason, count + 1);
      console.warn(`[Sentinel/RUM] dropped: ${reason}`);
    },
    disable() {
      if (!active) return;
      active = false;
      diag.disable();
    },
  };
}

const NOOP_DIAGNOSTICS: SentinelDiagnostics = {
  beforeSendFailure() {},
  lifecycleFailure() {},
  rumDrop() {},
  disable() {},
};
