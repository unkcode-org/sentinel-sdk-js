export type SentinelAttributePrimitive = string | number | boolean;
export type SentinelAttributeValue =
  | SentinelAttributePrimitive
  | string[]
  | number[]
  | boolean[];
export type SentinelAttributes = Readonly<Record<string, unknown>>;

export interface SentinelTelemetryDraft {
  signal: "log" | "span" | "metric";
  name: string;
  body?: string;
  attributes: Record<string, SentinelAttributeValue>;
}

export type BeforeSend = (
  draft: SentinelTelemetryDraft,
) => SentinelTelemetryDraft | null;

export interface SentinelConfig {
  readonly endpoint: string;
  readonly publicKey: string;
  readonly serviceName: string;
  readonly release?: string;
  readonly environment?: string;
  readonly tracesSampleRate?: number;
  readonly tracePropagationTargets?: readonly (string | RegExp)[];
  readonly instrumentFetch?: boolean;
  readonly captureErrors?: boolean;
  readonly diagnostics?: boolean;
  readonly beforeSend?: BeforeSend;
}

export interface NormalizedSentinelConfig {
  readonly endpoint: string;
  readonly signalUrls: {
    readonly traces: string;
    readonly logs: string;
    readonly metrics: string;
  };
  readonly publicKey: string;
  readonly serviceName: string;
  readonly release: string | undefined;
  readonly environment: string | undefined;
  readonly tracesSampleRate: number;
  readonly tracePropagationTargets: readonly (string | RegExp)[];
  readonly instrumentFetch: boolean;
  readonly captureErrors: boolean;
  readonly diagnostics: boolean;
  readonly beforeSend: BeforeSend | undefined;
}

export class SentinelInitializationError extends Error {
  override readonly name = "SentinelInitializationError";
}

const PUBLIC_KEY_PATTERN = /^sip_pub_[A-Za-z0-9._~-]+$/;

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 255) {
    throw new SentinelInitializationError(`${label} must be 1-255 characters`);
  }
  return normalized;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function signalUrl(endpoint: URL, signal: "traces" | "logs" | "metrics"): string {
  const copy = new URL(endpoint.href);
  const prefix = copy.pathname.replace(/\/+$/, "");
  copy.pathname = `${prefix}/v1/${signal}`;
  return copy.href;
}

function normalizePropagationTargets(
  targets: SentinelConfig["tracePropagationTargets"],
  signalUrls: NormalizedSentinelConfig["signalUrls"],
): readonly (string | RegExp)[] {
  const exporterUrls = Object.values(signalUrls);
  return [...(targets ?? [])].map(target => {
    if (target instanceof RegExp) {
      const stable = new RegExp(target.source, target.flags.replace(/[gy]/g, ""));
      if (exporterUrls.some(exporterUrl => stable.test(exporterUrl))) {
        throw new SentinelInitializationError(
          "Sentinel exporter URLs cannot be trace propagation targets",
        );
      }
      return stable;
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new SentinelInitializationError(
        "tracePropagationTargets string values must be absolute URLs",
      );
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new SentinelInitializationError(
        "tracePropagationTargets must be HTTP(S) URLs without credentials, query, or fragment",
      );
    }
    const normalized = parsed.href.replace(/\/$/, "");
    if (
      exporterUrls.some(
        exporterUrl =>
          exporterUrl === normalized || exporterUrl.startsWith(`${normalized}/`),
      )
    ) {
      throw new SentinelInitializationError(
        "Sentinel exporter URLs cannot be trace propagation targets",
      );
    }
    return normalized;
  });
}

export function normalizeConfig(config: SentinelConfig): NormalizedSentinelConfig {
  if (!PUBLIC_KEY_PATTERN.test(config.publicKey)) {
    throw new SentinelInitializationError(
      "publicKey must be a Sentinel public credential beginning with sip_pub_",
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new SentinelInitializationError("endpoint must be an absolute URL");
  }

  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new SentinelInitializationError(
      "endpoint must not contain credentials, a query, or a fragment",
    );
  }
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && isLoopback(endpoint.hostname))
  ) {
    throw new SentinelInitializationError(
      "endpoint must use HTTPS except on a loopback host",
    );
  }

  const tracesSampleRate = config.tracesSampleRate ?? 1;
  if (
    !Number.isFinite(tracesSampleRate) ||
    tracesSampleRate < 0 ||
    tracesSampleRate > 1
  ) {
    throw new SentinelInitializationError(
      "tracesSampleRate must be a finite number from 0 through 1",
    );
  }

  const endpointHref = endpoint.href.replace(/\/$/, "");
  const signalUrls = {
    traces: signalUrl(endpoint, "traces"),
    logs: signalUrl(endpoint, "logs"),
    metrics: signalUrl(endpoint, "metrics"),
  };
  return {
    endpoint: endpointHref,
    signalUrls,
    publicKey: config.publicKey,
    serviceName: requiredText(config.serviceName, "serviceName"),
    release: config.release?.trim() || undefined,
    environment: config.environment?.trim() || undefined,
    tracesSampleRate,
    tracePropagationTargets: normalizePropagationTargets(
      config.tracePropagationTargets,
      signalUrls,
    ),
    instrumentFetch: config.instrumentFetch ?? true,
    captureErrors: config.captureErrors ?? true,
    diagnostics: config.diagnostics ?? false,
    beforeSend: config.beforeSend,
  };
}

export function configsEquivalent(
  left: NormalizedSentinelConfig,
  right: NormalizedSentinelConfig,
): boolean {
  const scalarKeys = [
    "endpoint",
    "publicKey",
    "serviceName",
    "release",
    "environment",
    "tracesSampleRate",
    "instrumentFetch",
    "captureErrors",
    "diagnostics",
  ] as const;
  if (scalarKeys.some(key => left[key] !== right[key])) return false;
  if (left.beforeSend !== right.beforeSend) return false;
  if (
    left.tracePropagationTargets.length !== right.tracePropagationTargets.length
  ) {
    return false;
  }
  return left.tracePropagationTargets.every((target, index) => {
    const other = right.tracePropagationTargets[index];
    return target === other || String(target) === String(other);
  });
}
