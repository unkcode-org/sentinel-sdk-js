import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import type { Resource } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

import type { NormalizedSentinelConfig } from "../config";

export function createMeterProvider(
  config: NormalizedSentinelConfig,
  resource: Resource,
): MeterProvider {
  const exporter = new OTLPMetricExporter({
    url: config.signalUrls.metrics,
    headers: { Authorization: `Bearer ${config.publicKey}` },
    timeoutMillis: 10_000,
    concurrencyLimit: 2,
  });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
    exportTimeoutMillis: 10_000,
    cardinalityLimits: { default: 2_000 },
  });
  return new MeterProvider({ resource, readers: [reader] });
}
