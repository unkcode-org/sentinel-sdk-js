import { describe, expect, it } from "vitest";
import { sanitizeReplayEvent } from "../../src/replay/privacy";

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
});
