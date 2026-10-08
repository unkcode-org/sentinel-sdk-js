import { expect, it } from "vitest";
import { ReplayRuntime } from "../../src/replay/runtime";
import type { SafeReplayEvent } from "../../src/replay/privacy";

it("evicts complete checkpoint groups, never an anchor alone", () => {
  const runtime = Reflect.construct(ReplayRuntime, [{}, { currentSessionId: () => "session" }, { replayOutcome() {} }]) as {
    groups: { events: SafeReplayEvent[]; bytes: number; started: number }[];
    evict(): void;
  };
  const meta = (t: number): SafeReplayEvent => ({ type: 4, timestamp: t, data: { href: "about:blank", width: 1, height: 1 } });
  const full = (t: number): SafeReplayEvent => ({ type: 2, timestamp: t, data: { node: { id: 1, type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } } });
  const old = Date.now() - 60_000;
  runtime.groups = [
    { started: old, bytes: 128, events: [meta(old), full(old + 1), { type: 3, timestamp: old + 2, data: { source: 0, texts: [], attributes: [], removes: [], adds: [] } }] },
    { started: Date.now() - 1000, bytes: 128, events: [meta(Date.now() - 1000), full(Date.now() - 999)] },
  ];
  runtime.evict();
  expect(runtime.groups).toHaveLength(1);
  expect(runtime.groups[0]?.events.map(event => event.type)).toEqual([4, 2]);
});

it("applies byte and event pressure by removing a whole oldest group", () => {
  const runtime = Reflect.construct(ReplayRuntime, [{}, { currentSessionId: () => "session" }, { replayOutcome() {} }]) as {
    groups: { events: SafeReplayEvent[]; bytes: number; started: number }[];
    evict(): void;
  };
  const anchor: SafeReplayEvent[] = [
    { type: 4, timestamp: Date.now(), data: { href: "about:blank", width: 1, height: 1 } },
    { type: 2, timestamp: Date.now(), data: { node: { id: 1, type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } } },
  ];
  runtime.groups = [
    { started: Date.now(), bytes: 1_200_000, events: [...anchor, ...Array<SafeReplayEvent>(3000).fill(anchor[0]!)] },
    { started: Date.now(), bytes: 1_200_000, events: [...anchor, ...Array<SafeReplayEvent>(3000).fill(anchor[0]!)] },
  ];
  runtime.evict();
  expect(runtime.groups).toHaveLength(1);
  expect(runtime.groups[0]?.events.slice(0, 2).map(event => event.type)).toEqual([4, 2]);
});
