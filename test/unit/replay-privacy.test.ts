import { describe, expect, it } from "vitest";
import { sanitizeReplayEvent } from "../../src/replay/privacy";

function jsonDepth(value: unknown, depth = 0): number {
  if (!value || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((max, child) => Math.max(max, jsonDepth(child, depth + 1)), depth);
}

describe("replay prebuffer privacy boundary", () => {
  it("removes text, URLs, attributes and blocked subtree contents before retention", () => {
    const blocked = new Set<number>();
    const meta = sanitizeReplayEvent({ type: 4, timestamp: 100, data: { href: "https://example.test/?token=secret", width: 100, height: 100 } }, blocked);
    const full = sanitizeReplayEvent({ type: 2, timestamp: 101, data: { node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: "div", attributes: { title: "secret" }, childNodes: [{ type: 3, id: 3, textContent: "secret" }] },
      { type: 2, id: 4, tagName: "section", attributes: { "data-sentinel-private": "", href: "secret" }, childNodes: [{ type: 3, id: 5, textContent: "secret" }] },
      { type: 2, id: 6, tagName: "iframe", attributes: { src: "https://secret.test" }, childNodes: [] },
    ] }, initialOffset: { top: 0, left: 0 } } }, blocked);
    expect(JSON.stringify([meta, full])).not.toContain("secret");
    expect(blocked).toEqual(new Set([4, 6]));
    const mutation = sanitizeReplayEvent({ type: 3, timestamp: 102, data: { source: 0,
      texts: [{ id: 3, value: "secret" }, { id: 5, value: "secret" }],
      attributes: [{ id: 2, attributes: { href: "secret" } }],
      removes: [], adds: [{ parentId: 4, nextId: null, node: { type: 3, id: 7, textContent: "secret" } }],
    } }, blocked, id => id === 5);
    expect(JSON.stringify(mutation)).not.toContain("secret");
    expect(JSON.stringify(mutation)).not.toContain('"id":5');
  });

  it("rejects plugin and unsupported incremental surfaces", () => {
    expect(sanitizeReplayEvent({ type: 6, timestamp: 1, data: { payload: "secret" } }, new Set())).toBeNull();
    expect(sanitizeReplayEvent({ type: 3, timestamp: 1, data: { source: 9, payload: "secret" } }, new Set())).toBeNull();
  });

  it("bounds deep rrweb trees for Ingest's 32-level JSON scanner", () => {
    const blocked = new Set<number>();
    let node: Record<string, unknown> = { type: 2, id: 40, tagName: "span", attributes: {}, childNodes: [] };
    for (let id = 39; id >= 2; id--) node = { type: 2, id, tagName: "div", attributes: {}, childNodes: [node] };
    const raw = { type: 2, timestamp: 100, data: { node: { type: 0, id: 1, childNodes: [node] }, initialOffset: { top: 0, left: 0 } } };
    const envelope = (event: unknown) => ({ events: [event] });
    expect(jsonDepth(envelope(raw))).toBeGreaterThan(32);
    const safe = sanitizeReplayEvent(raw, blocked);
    expect(safe).not.toBeNull();
    expect(jsonDepth(envelope(safe))).toBeLessThanOrEqual(32);
    expect(blocked.has(40)).toBe(true);
    expect(sanitizeReplayEvent({ type: 3, timestamp: 101, data: { source: 0, texts: [{ id: 40, value: "secret" }], attributes: [], removes: [], adds: [] } }, blocked)).toBeNull();
    const add = sanitizeReplayEvent({ type: 3, timestamp: 102, data: { source: 0, texts: [], attributes: [], removes: [], adds: [
      { parentId: 1, nextId: null, node: { type: 2, id: 100, tagName: "div", attributes: {}, childNodes: [node] } },
    ] } }, blocked);
    expect(add).not.toBeNull();
    expect(jsonDepth(envelope(add))).toBeLessThanOrEqual(32);
  });
});
