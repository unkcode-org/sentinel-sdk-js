import { redactText } from "../privacy/sanitizer";

type Mechanism = "error" | "unhandledrejection";

type RumErrorData = Record<"error_type" | "message", string>;

const SAFE_ERROR_TYPE = /^[A-Za-z0-9._+~-]+$/;
const MAX_ERROR_TYPE_BYTES = 128;
const MAX_MESSAGE_BYTES = 1_024;
const encoder = new TextEncoder();

function boundedMessage(value: string): string | undefined {
  // The shared sanitizer strips query strings and fragments from absolute URLs.
  const redacted = redactText(value);
  if (!redacted || [...redacted].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === "?" || character === "#")) return undefined;
  let result = "";
  let bytes = 0;
  for (const character of redacted) {
    const size = encoder.encode(character).length;
    if (bytes + size > MAX_MESSAGE_BYTES) break;
    result += character;
    bytes += size;
  }
  return result || undefined;
}

export function normalizeRumError(error: unknown, mechanism: Mechanism): RumErrorData {
  const fallback: RumErrorData = mechanism === "error"
    ? { error_type: "Error", message: "Browser error" }
    : { error_type: "UnhandledRejection", message: "Unhandled promise rejection" };

  try {
    if (error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException)) {
      const name = error.name;
      const message = error.message;
      return {
        error_type: typeof name === "string" && SAFE_ERROR_TYPE.test(name) && encoder.encode(name).length <= MAX_ERROR_TYPE_BYTES
          ? name : fallback.error_type,
        message: typeof message === "string" ? boundedMessage(message) ?? fallback.message : fallback.message,
      };
    }
  } catch {
    return fallback;
  }

  if (mechanism === "unhandledrejection" && typeof error === "string") {
    return { ...fallback, message: boundedMessage(error) ?? fallback.message };
  }
  return fallback;
}
