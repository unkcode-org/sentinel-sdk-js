// This is an admission boundary: no reference to a raw rrweb event is retained.
export interface SafeReplayEvent { type: number; timestamp: number; data: Record<string, unknown> }

const SAFE_TAGS = new Set("html head body div span p main section article aside header footer nav h1 h2 h3 h4 h5 h6 ul ol li dl dt dd button label strong em b i small br hr table thead tbody tr td th form fieldset legend pre code blockquote a img".split(" "));
const UNSAFE_TAGS = new Set("iframe frame frameset canvas video audio script style object embed svg link meta input textarea select option picture source track template noscript".split(" "));
const MAX_NODES = 20_000;
const MAX_DEPTH = 64;

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function id(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function coordinate(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000; }
function marker(attrs: Record<string, unknown> | null): boolean { return attrs !== null && Object.prototype.hasOwnProperty.call(attrs, "data-sentinel-private"); }

export function sanitizeReplayEvent(raw: unknown, blockedIds: Set<number>, isPrivateId?: (id: number) => boolean): SafeReplayEvent | null {
  const event = obj(raw);
  if (!event || !Number.isSafeInteger(event.timestamp) || !Number.isSafeInteger(event.type)) return null;
  const timestamp = event.timestamp as number;
  const data = obj(event.data);
  if (!data || timestamp < 0) return null;
  if (event.type === 0 || event.type === 1) return { type: event.type, timestamp, data: {} };
  if (event.type === 4) {
    if (!coordinate(data.width) || !coordinate(data.height)) return null;
    return { type: 4, timestamp, data: { href: "about:blank", width: data.width, height: data.height } };
  }
  let nodes = 0;
  const cleanNode = (rawNode: unknown, depth: number): Record<string, unknown> => {
    const node = obj(rawNode);
    if (!node || !id(node.id) || !Number.isInteger(node.type) || depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new Error("invalid node");
    const common = { id: node.id, type: node.type };
    if (node.type === 0) {
      if (!Array.isArray(node.childNodes)) throw new Error("invalid document");
      return { ...common, childNodes: node.childNodes.map(child => cleanNode(child, depth + 1)) };
    }
    if (node.type === 1) return { ...common, name: "html", publicId: "", systemId: "" };
    if (node.type === 3 || node.type === 4 || node.type === 5) return { ...common, textContent: node.type === 3 ? "*" : "" };
    if (node.type !== 2 || typeof node.tagName !== "string") throw new Error("invalid node type");
    const tag = node.tagName.toLowerCase();
    const attrs = obj(node.attributes);
    const privateNode = marker(attrs) || node.isShadowHost === true || node.isShadow === true ||
      UNSAFE_TAGS.has(tag) || !SAFE_TAGS.has(tag);
    if (privateNode) {
      blockedIds.add(node.id);
      return { ...common, tagName: "div", attributes: {}, childNodes: [] };
    }
    if (!Array.isArray(node.childNodes)) throw new Error("invalid element");
    return { ...common, tagName: tag, attributes: {}, childNodes: node.childNodes.map(child => cleanNode(child, depth + 1)) };
  };
  try {
    if (event.type === 2) {
      const offset = obj(data.initialOffset);
      if (!offset || !coordinate(offset.top) || !coordinate(offset.left)) return null;
      blockedIds.clear();
      const node = cleanNode(data.node, 0);
      if (node.type !== 0) return null;
      return { type: 2, timestamp, data: { node, initialOffset: { top: offset.top, left: offset.left } } };
    }
    if (event.type !== 3 || data.source !== 0) return null;
    if (!Array.isArray(data.texts) || !Array.isArray(data.attributes) || !Array.isArray(data.removes) || !Array.isArray(data.adds)) return null;
    for (const value of data.attributes) {
      const item = obj(value);
      if (item && id(item.id) && marker(obj(item.attributes))) blockedIds.add(item.id);
    }
    const hidden = (value: unknown): boolean => id(value) && (blockedIds.has(value) || (isPrivateId?.(value) ?? false));
    const texts = data.texts.flatMap(value => {
      const item = obj(value);
      return item && id(item.id) && !hidden(item.id) ? [{ id: item.id, value: "*" }] : [];
    });
    // All attributes are removed, including URL, CSS, value, and user-defined attributes.
    const attributes: Record<string, unknown>[] = [];
    const removes = data.removes.flatMap(value => {
      const item = obj(value);
      return item && id(item.id) && id(item.parentId) && !hidden(item.parentId) ? [{ id: item.id, parentId: item.parentId }] : [];
    });
    const adds = data.adds.flatMap(value => {
      const item = obj(value);
      if (!item || !id(item.parentId) || hidden(item.parentId)) return [];
      const node = cleanNode(item.node, 0);
      return [{ parentId: item.parentId, nextId: typeof item.nextId === "number" ? item.nextId : null,
        ...(typeof item.previousId === "number" ? { previousId: item.previousId } : {}), node }];
    });
    if (!texts.length && !removes.length && !adds.length) return null;
    return { type: 3, timestamp, data: { source: 0, texts, attributes, removes, adds } };
  } catch { return null; }
}
