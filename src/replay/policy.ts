import type { NormalizedSentinelConfig } from "../config";

export interface ReplayLimits {
  max_wire_request_bytes: number;
  max_decoded_request_bytes: number;
  max_events_per_chunk: number;
  max_chunks_per_replay: number;
  max_pages_per_replay: number;
  max_decoded_replay_bytes: number;
  max_promoted_duration_seconds: number;
}

export interface ReplayPolicy {
  readonly limits: ReplayLimits;
  readonly expiresAt: number; // performance.now() deadline
}

const BOUNDS: Record<keyof ReplayLimits, [number, number]> = {
  max_wire_request_bytes: [1024, 262144],
  max_decoded_request_bytes: [1024, 1048576],
  max_events_per_chunk: [1, 1000],
  max_chunks_per_replay: [1, 64],
  max_pages_per_replay: [1, 16],
  max_decoded_replay_bytes: [1048576, 16777216],
  max_promoted_duration_seconds: [1, 900],
};

function exactKeys(value: Record<string, unknown>, names: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === names.length && names.sort().every((name, i) => actual[i] === name);
}

export function parseReplayPolicy(value: unknown, dateHeader: string | null, requestedAt: number, receivedAt: number): ReplayPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.schema_version !== 1 || body.enabled !== true || body.contract_version !== 1 || body.recorder_major !== 2 ||
      !exactKeys(body, ["schema_version", "enabled", "contract_version", "recorder_major", "fresh_until", "limits"])) return null;
  if (typeof body.fresh_until !== "string" || !Number.isFinite(Date.parse(body.fresh_until))) return null;
  const serverDate = dateHeader ? Date.parse(dateHeader) : NaN;
  // Date has one-second precision. Charge the entire request and body-read time
  // against the lease, then anchor it at request start on the monotonic clock.
  const remaining = Date.parse(body.fresh_until) - serverDate - 1250;
  if (!Number.isFinite(serverDate) || !Number.isFinite(requestedAt) || !Number.isFinite(receivedAt) ||
      receivedAt < requestedAt || remaining <= 0 || remaining > 120_000) return null;
  const expiresAt = requestedAt + remaining;
  if (expiresAt <= receivedAt) return null;
  if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits)) return null;
  const limits = body.limits as Record<string, unknown>;
  if (!exactKeys(limits, Object.keys(BOUNDS))) return null;
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const n = limits[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) return null;
  }
  if ((limits.max_decoded_request_bytes as number) < (limits.max_wire_request_bytes as number)) return null;
  return { limits: limits as unknown as ReplayLimits, expiresAt };
}

export async function discoverReplayPolicy(config: NormalizedSentinelConfig, signal: AbortSignal): Promise<ReplayPolicy | null> {
  const requestedAt = performance.now();
  const response = await fetch(config.replayPolicyUrl, {
    method: "GET", headers: { Authorization: `Bearer ${config.publicKey}` }, cache: "no-store", redirect: "error", signal,
  });
  if (response.status !== 200) return null;
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  if (!response.headers.get("cache-control")?.toLowerCase().includes("no-store")) return null;
  const body = await response.text();
  if (body.length > 4096) return null;
  try { return parseReplayPolicy(JSON.parse(body) as unknown, response.headers.get("date"), requestedAt, performance.now()); }
  catch { return null; }
}
