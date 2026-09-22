import type {
  SentinelAttributes,
  SentinelAttributeValue,
} from "../config";

const MAX_ATTRIBUTES = 64;
const MAX_ARRAY_LENGTH = 32;
const MAX_KEY_LENGTH = 128;
const MAX_STRING_LENGTH = 1_024;
const MAX_STACK_LENGTH = 8_192;
const REDACTED = "[REDACTED]";
const RESERVED_PREFIXES = ["sentinel.", "telemetry.sdk.", "service."];
const SENSITIVE_KEY =
  /(?:^|[._-])(authorization|cookie|password|passwd|secret|token|api[._-]?key)(?:$|[._-])/i;
const ABSOLUTE_URL = /https?:\/\/[^\s"'<>]+/gi;

function truncate(value: string, maximum = MAX_STRING_LENGTH): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

export function sanitizeUrl(value: string): string | undefined {
  try {
    if (value.startsWith("/")) {
      const relative = new URL(value, "https://sentinel.invalid");
      return relative.pathname;
    }
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function redactText(value: string): string {
  return truncate(
    value.replace(ABSOLUTE_URL, candidate => sanitizeUrl(candidate) ?? REDACTED),
  );
}

function sanitizePrimitive(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") {
    const sanitizedUrl = sanitizeUrl(value);
    return sanitizedUrl ?? redactText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function sanitizeValue(value: unknown): SentinelAttributeValue | undefined {
  const primitive = sanitizePrimitive(value);
  if (primitive !== undefined) {
    return primitive;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values: (string | number | boolean)[] = [];
  let expectedType: string | undefined;
  for (const entry of value.slice(0, MAX_ARRAY_LENGTH)) {
    const sanitized = sanitizePrimitive(entry);
    if (sanitized === undefined) continue;
    const entryType = typeof sanitized;
    if (expectedType === undefined) expectedType = entryType;
    if (entryType === expectedType) values.push(sanitized);
  }
  if (values.length === 0) return undefined;
  if (expectedType === "string") return values as string[];
  if (expectedType === "number") return values as number[];
  return values as boolean[];
}

function isReserved(key: string): boolean {
  return RESERVED_PREFIXES.some(prefix => key.startsWith(prefix));
}

export function sanitizeAttributes(
  input: SentinelAttributes | undefined,
): Record<string, SentinelAttributeValue> {
  if (input === undefined || input === null || typeof input !== "object") {
    return {};
  }

  const output: Record<string, SentinelAttributeValue> = {};
  for (const key of Object.keys(input).slice(0, MAX_ATTRIBUTES)) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || isReserved(key)) {
      continue;
    }
    if (SENSITIVE_KEY.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    let value: unknown;
    try {
      value = input[key];
    } catch {
      continue;
    }
    const sanitized = sanitizeValue(value);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

export interface SerializedError {
  readonly type: string;
  readonly message: string;
  readonly stack?: string;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const result: SerializedError = {
      type: truncate(error.name || "Error", 128),
      message: redactText(error.message),
      ...(error.stack
        ? { stack: truncate(redactText(error.stack), MAX_STACK_LENGTH) }
        : {}),
    };
    return result;
  }
  return {
    type: "UnknownError",
    message: redactText(typeof error === "string" ? error : String(error)),
  };
}
