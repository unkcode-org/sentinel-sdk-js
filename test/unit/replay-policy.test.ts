import { describe, expect, it } from "vitest";
import { parseReplayPolicy } from "../../src/replay/policy";

const limits = { max_wire_request_bytes: 262144, max_decoded_request_bytes: 1048576,
  max_events_per_chunk: 1000, max_chunks_per_replay: 64, max_pages_per_replay: 16,
  max_decoded_replay_bytes: 16777216, max_promoted_duration_seconds: 900 };
const now = Date.parse("2026-10-01T12:00:00Z");
const enabled = { schema_version: 1, enabled: true, contract_version: 1, recorder_major: 2,
  fresh_until: "2026-10-01T12:00:08Z", limits };

describe("replay policy admission", () => {
  it("requires a fresh exact v1 enabled projection", () => {
    expect(parseReplayPolicy(enabled, null, now)?.limits).toEqual(limits);
    for (const bad of [
      { ...enabled, enabled: false }, { ...enabled, contract_version: 2 },
      { ...enabled, recorder_major: 3 }, { ...enabled, fresh_until: "2026-10-01T11:59:59Z" },
      { ...enabled, tenant_id: "unsafe" }, { ...enabled, limits: { ...limits, max_events_per_chunk: 1001 } },
      { ...enabled, limits: { ...limits, max_decoded_request_bytes: 1000 } },
    ]) expect(parseReplayPolicy(bad, null, now)).toBeNull();
  });
});
