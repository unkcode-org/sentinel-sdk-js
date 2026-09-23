import type { Meter, Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import type { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

import type { NormalizedSentinelConfig } from "../config";
import { createLoggerProvider } from "./logs";
import { createMeterProvider } from "./metrics";
import { createResource } from "./resource";
import { createTraceProvider } from "./traces";

export interface TelemetryRuntime {
  readonly tracerProvider: WebTracerProvider;
  readonly loggerProvider: LoggerProvider;
  readonly meterProvider: MeterProvider;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly meter: Meter;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createTelemetry(
  config: NormalizedSentinelConfig,
): TelemetryRuntime {
  const resource = createResource(config);
  const tracerProvider = createTraceProvider(config, resource);
  const loggerProvider = createLoggerProvider(config, resource);
  const meterProvider = createMeterProvider(config, resource);

  return {
    tracerProvider,
    loggerProvider,
    meterProvider,
    tracer: tracerProvider.getTracer("@unkcode/sentinel", "0.1.1"),
    logger: loggerProvider.getLogger("@unkcode/sentinel", "0.1.1"),
    meter: meterProvider.getMeter("@unkcode/sentinel", "0.1.1"),
    async flush() {
      await Promise.all([
        tracerProvider.forceFlush(),
        loggerProvider.forceFlush(),
        meterProvider.forceFlush(),
      ]);
    },
    async shutdown() {
      await Promise.all([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
    },
  };
}
