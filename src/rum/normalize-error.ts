import { redactText, sanitizeUrl } from "../privacy/sanitizer";

type Mechanism = "error" | "unhandledrejection";

type RumErrorData = Record<"error_type" | "message", string> & { stack?: string };

const SAFE_ERROR_TYPE = /^[A-Za-z0-9._+~-]+$/;
const MAX_ERROR_TYPE_BYTES = 128;
const MAX_MESSAGE_BYTES = 1_024;
const MAX_STACK_INPUT_UNITS = 16_384;
const MAX_STACK_INPUT_LINES = 64;
const MAX_STACK_FRAMES = 32;
const MAX_STACK_FRAME_BYTES = 512;
const MAX_STACK_BYTES = 4_096;
const SCRIPT_BASENAME = /^[A-Za-z0-9_.-]{1,128}\.(?:js|mjs)$/;
const encoder = new TextEncoder();

function safeFrame(line: string): string | undefined {
  const trimmed = line.trim();
  let location: string;
  if (trimmed.startsWith("at ")) {
    const body = trimmed.slice(3);
    const open = body.lastIndexOf("(");
    location = open >= 0 && body.endsWith(")") ? body.slice(open + 1, -1) : body;
  } else {
    const at = trimmed.lastIndexOf("@");
    if (at < 0) return undefined;
    location = trimmed.slice(at + 1);
  }
  const match = /^(.*):([1-9][0-9]{0,8}):([1-9][0-9]{0,8})$/.exec(location);
  if (!match) return undefined;
  const rawUrl = match[1]!;
  if (!/^https?:\/\//i.test(rawUrl) && !(rawUrl.startsWith("/") && !rawUrl.startsWith("//") && typeof window !== "undefined")) return undefined;
  try {
    const parsed = new URL(rawUrl, typeof window === "undefined" ? undefined : window.location.href);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
    const redacted = sanitizeUrl(parsed.href);
    if (!redacted) return undefined;
    const clean = new URL(redacted);
    const basename = clean.pathname.slice(clean.pathname.lastIndexOf("/") + 1);
    if (!SCRIPT_BASENAME.test(basename)) return undefined;
    const frame = `at ${clean.origin}/${basename}:${match[2]}:${match[3]}`;
    const safeText = [...frame].every(character => character !== "?" && character !== "#" && character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
    return safeText && encoder.encode(frame).length <= MAX_STACK_FRAME_BYTES ? frame : undefined;
  } catch {
    return undefined;
  }
}

function safeStack(error: Error): string | undefined {
  let provided: unknown;
  try { provided = error.stack; } catch { return undefined; }
  if (typeof provided !== "string" || !provided) return undefined;
  const truncated = provided.length > MAX_STACK_INPUT_UNITS;
  const inspected = provided.slice(0, MAX_STACK_INPUT_UNITS);
  const lines = inspected.split("\n");
  if (truncated && !inspected.endsWith("\n")) lines.pop();
  const frames: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(0, MAX_STACK_INPUT_LINES)) {
    const frame = safeFrame(line);
    if (!frame) continue;
    const size = encoder.encode(frame).length + (frames.length ? 1 : 0);
    if (bytes + size > MAX_STACK_BYTES) break;
    frames.push(frame);
    bytes += size;
    if (frames.length === MAX_STACK_FRAMES) break;
  }
  return frames.length ? frames.join("\n") : undefined;
}

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
      const stack = error instanceof Error ? safeStack(error) : undefined;
      return {
        error_type: typeof name === "string" && SAFE_ERROR_TYPE.test(name) && encoder.encode(name).length <= MAX_ERROR_TYPE_BYTES
          ? name : fallback.error_type,
        message: typeof message === "string" ? boundedMessage(message) ?? fallback.message : fallback.message,
        ...(stack ? { stack } : {}),
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
