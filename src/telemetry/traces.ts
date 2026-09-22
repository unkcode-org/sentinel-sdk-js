import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  WebTracerProvider,
} from "@opentelemetry/sdk-trace-web";

import type { NormalizedSentinelConfig } from "../config";
import { FetchUrlSpanProcessor } from "../privacy/fetch-url-span-processor";

export function createTraceProvider(
  config: NormalizedSentinelConfig,
  resource: Resource,
): WebTracerProvider {
  const exporter = new OTLPTraceExporter({
    url: config.signalUrls.traces,
    headers: { Authorization: `Bearer ${config.publicKey}` },
    timeoutMillis: 10_000,
    concurrencyLimit: 2,
  });
  const batchProcessor = new BatchSpanProcessor(exporter, {
    maxQueueSize: 2_048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5_000,
    exportTimeoutMillis: 10_000,
  });
  return new WebTracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.tracesSampleRate),
    }),
    spanProcessors: [new FetchUrlSpanProcessor(), batchProcessor],
    spanLimits: {
      attributeCountLimit: 64,
      attributeValueLengthLimit: 1_024,
      eventCountLimit: 64,
      linkCountLimit: 32,
    },
  });
}
