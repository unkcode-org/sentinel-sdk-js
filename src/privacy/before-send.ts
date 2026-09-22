import type {
  NormalizedSentinelConfig,
  SentinelTelemetryDraft,
} from "../config";
import type { SentinelDiagnostics } from "../diagnostics";
import { redactText, sanitizeAttributes } from "./sanitizer";

function sanitizeDraft(
  draft: SentinelTelemetryDraft,
  expectedSignal: SentinelTelemetryDraft["signal"],
): SentinelTelemetryDraft | null {
  if (draft.signal !== expectedSignal) return null;
  return {
    signal: expectedSignal,
    name: redactText(draft.name),
    ...(draft.body === undefined ? {} : { body: redactText(draft.body) }),
    attributes: sanitizeAttributes(draft.attributes),
  };
}

export function applyBeforeSend(
  config: NormalizedSentinelConfig,
  draft: SentinelTelemetryDraft,
  diagnostics?: SentinelDiagnostics,
): SentinelTelemetryDraft | null {
  const sanitized = sanitizeDraft(draft, draft.signal);
  if (sanitized === null || config.beforeSend === undefined) return sanitized;
  try {
    const replacement = config.beforeSend(sanitized);
    return replacement === null
      ? null
      : sanitizeDraft(replacement, sanitized.signal);
  } catch {
    diagnostics?.beforeSendFailure();
    return null;
  }
}
