import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-web";
import {
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";

const FETCH_SCOPE = "@opentelemetry/instrumentation-fetch";

/**
 * A synchronous privacy policy hook for spans created by the official fetch
 * instrumentation. It never buffers, batches, or exports spans.
 */
export class FetchUrlSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    void parentContext;
    if (span.instrumentationScope.name !== FETCH_SCOPE) return;

    const fullUrl = span.attributes[ATTR_URL_FULL];
    if (typeof fullUrl !== "string") return;

    let url: URL;
    try {
      url = new URL(fullUrl);
    } catch {
      span.setAttribute(ATTR_URL_FULL, "https://invalid.invalid/");
      span.setAttribute(ATTR_URL_PATH, "/");
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") return;

    span.setAttribute(ATTR_URL_FULL, `${url.origin}${url.pathname}`);
    span.setAttribute(ATTR_URL_SCHEME, url.protocol.slice(0, -1));
    span.setAttribute(ATTR_URL_PATH, url.pathname);
    span.setAttribute(ATTR_SERVER_ADDRESS, url.hostname);
    if (url.port) span.setAttribute(ATTR_SERVER_PORT, Number(url.port));
  }

  onEnd(span: ReadableSpan): void {
    void span;
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
