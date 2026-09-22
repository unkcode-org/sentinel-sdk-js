import type { TracerProvider } from "@opentelemetry/api";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";

import type { NormalizedSentinelConfig } from "../config";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exporterMatcher(url: string): RegExp {
  return new RegExp(`^${escapeRegExp(url)}(?:[?#].*)?$`);
}

function propagationMatcher(target: string | RegExp): RegExp {
  if (target instanceof RegExp) {
    return new RegExp(target.source, target.flags.replace(/[gy]/g, ""));
  }
  const normalized = target.replace(/\/$/, "");
  return new RegExp(`^${escapeRegExp(normalized)}(?:/|$|[?#])`);
}

export interface PreparedFetchInstrumentation {
  readonly instrumentation: FetchInstrumentation;
  enable(): void;
  disable(): void;
}

export function prepareFetchInstrumentation(
  config: NormalizedSentinelConfig,
  tracerProvider: TracerProvider,
): PreparedFetchInstrumentation | undefined {
  if (!config.instrumentFetch) return undefined;

  const instrumentation = new FetchInstrumentation({
    enabled: false,
    ignoreUrls: Object.values(config.signalUrls).map(exporterMatcher),
    propagateTraceHeaderCorsUrls: config.tracePropagationTargets.map(
      propagationMatcher,
    ),
    ignoreNetworkEvents: false,
    measureRequestSize: false,
  });
  instrumentation.setTracerProvider(tracerProvider);

  let enabled = false;
  return {
    instrumentation,
    enable() {
      if (enabled) return;
      instrumentation.enable();
      enabled = true;
    },
    disable() {
      if (!enabled) return;
      instrumentation.disable();
      enabled = false;
    },
  };
}
