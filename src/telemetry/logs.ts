import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import type { Resource } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";

import type { NormalizedSentinelConfig } from "../config";

export function createLoggerProvider(
  config: NormalizedSentinelConfig,
  resource: Resource,
): LoggerProvider {
  const exporter = new OTLPLogExporter({
    url: config.signalUrls.logs,
    headers: { Authorization: `Bearer ${config.publicKey}` },
    timeoutMillis: 10_000,
    concurrencyLimit: 2,
  });
  return new LoggerProvider({
    resource,
    logRecordLimits: {
      attributeCountLimit: 64,
      attributeValueLengthLimit: 1_024,
    },
    processors: [
      new BatchLogRecordProcessor({
        exporter,
        maxQueueSize: 2_048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 1_000,
        exportTimeoutMillis: 10_000,
      }),
    ],
  });
}
