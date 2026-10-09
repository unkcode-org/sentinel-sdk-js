import { describe, expect, it } from "vitest";
import { parseReplayPolicy } from "../../src/replay/policy";

const limits = { max_wire_request_bytes: 262144, max_decoded_request_bytes: 1048576,
  max_events_per_chunk: 1000, max_chunks_per_replay: 64, max_pages_per_replay: 16,
  max_decoded_replay_bytes: 16777216, max_promoted_duration_seconds: 900 };
const serverDate = "Thu, 01 Oct 2026 12:00:00 GMT";
const enabled = { schema_version: 1, enabled: true, contract_version: 1, recorder_major: 2,
  fresh_until: "2026-10-01T12:00:08Z", limits };

describe("replay policy admission", () => {
  it("requires a fresh exact v1 enabled projection", () => {
    expect(parseReplayPolicy(enabled, serverDate, 100, 200)?.limits).toEqual(limits);
    for (const bad of [
      { ...enabled, enabled: false }, { ...enabled, contract_version: 2 },
      { ...enabled, recorder_major: 3 }, { ...enabled, fresh_until: "2026-10-01T11:59:59Z" },
      { ...enabled, tenant_id: "unsafe" }, { ...enabled, limits: { ...limits, max_events_per_chunk: 1001 } },
      { ...enabled, limits: { ...limits, max_decoded_request_bytes: 1000 } },
    ]) expect(parseReplayPolicy(bad, serverDate, 100, 200)).toBeNull();
  });

  it("anchors a short lease to request start and charges elapsed time", () => {
    expect(parseReplayPolicy(enabled, serverDate, 100, 200)?.expiresAt).toBe(6850);
    expect(parseReplayPolicy(enabled, serverDate, 100, 6850)).toBeNull();
    expect(parseReplayPolicy({ ...enabled, fresh_until: "2026-10-01T12:00:02Z" }, serverDate, 100, 800)?.expiresAt).toBe(850);
    expect(parseReplayPolicy({ ...enabled, fresh_until: "2026-10-01T12:00:02Z" }, serverDate, 100, 850)).toBeNull();
  });

  it("keeps the server's longer freshness window within the contract limit", () => {
    expect(parseReplayPolicy({ ...enabled, fresh_until: "2026-10-01T12:02:00Z" }, serverDate, 100, 200)?.expiresAt).toBe(118850);
    expect(parseReplayPolicy({ ...enabled, fresh_until: "2026-10-01T12:02:02Z" }, serverDate, 100, 200)).toBeNull();
  });

  it("fails closed without a usable server Date or monotonic timing", () => {
    for (const date of [null, "invalid"]) expect(parseReplayPolicy(enabled, date, 100, 200)).toBeNull();
    expect(parseReplayPolicy(enabled, serverDate, 200, 100)).toBeNull();
    expect(parseReplayPolicy(enabled, serverDate, NaN, 100)).toBeNull();
  });
});
