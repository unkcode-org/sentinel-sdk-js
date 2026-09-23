import { SpanStatusCode } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-web";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";

const FETCH_SCOPE = "@opentelemetry/instrumentation-fetch";
const HTTP_METHOD_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function readHttpMethod(span: Span): string | undefined {
  const method = span.attributes[ATTR_HTTP_REQUEST_METHOD];
  if (typeof method !== "string" || !HTTP_METHOD_PATTERN.test(method)) {
    return undefined;
  }
  return method.toUpperCase();
}

/**
 * A synchronous privacy policy hook for spans created by the official fetch
 * instrumentation. It never buffers, batches, or exports spans.
 */
export class FetchUrlSpanProcessor implements SpanProcessor {
  constructor(private readonly onFetchEnd?: (method: string, route: string, status?: number, failed?: boolean) => void) {}
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

    const method = readHttpMethod(span);
    if (method !== undefined) span.updateName(`${method} ${url.pathname}`);
  }

  onEnd(span: ReadableSpan): void {
    if (!this.onFetchEnd || span.instrumentationScope?.name !== FETCH_SCOPE) return;
    const method = span.attributes[ATTR_HTTP_REQUEST_METHOD];
    const route = span.attributes[ATTR_URL_PATH];
    const status = span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE];
    if (typeof method !== "string" || typeof route !== "string") return;
    this.onFetchEnd(method.toUpperCase(), route, typeof status === "number" ? status : undefined, span.status.code === SpanStatusCode.ERROR);
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
