// This is an admission boundary: no reference to a raw rrweb event is retained.
export interface SafeReplayEvent { type: number; timestamp: number; data: Record<string, unknown> }
import type { VisualPolicy } from "./visual-policy";
export interface ReplayPresentation {
  policy: VisualPolicy;
  baseForId(id: number): string;
  tagForId(id: number): string;
  styleForId(id: number): string;
  useFallback?: boolean;
  textForId(id: number, value: string): string;
}

const SAFE_TAGS = new Set("html head body div span p main section article aside header footer nav h1 h2 h3 h4 h5 h6 ul ol li dl dt dd button label strong em b i small br hr table thead tbody tr td th form fieldset legend pre code blockquote a img".split(" "));
const UNSAFE_TAGS = new Set("iframe frame frameset canvas video audio script style object embed svg link meta input textarea select option picture source track template noscript".split(" "));
const VISUAL_TAGS = new Set("style link input textarea select option svg path g rect circle ellipse line polyline polygon defs use symbol clippath lineargradient radialgradient stop".split(" "));
const MAX_NODES = 20_000;
// Ingest's replay JSON scanner accepts nesting through depth 32. A mutation
// add wraps its node more deeply than a full snapshot (root/events/event/data/
// adds/item/node), and each DOM child adds a childNodes array and a node.
// At node depth 12 its childNodes array is at JSON depth 31.
const MAX_DEPTH = 12;

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function id(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function coordinate(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000; }
function marker(attrs: Record<string, unknown> | null): boolean { return attrs !== null && Object.prototype.hasOwnProperty.call(attrs, "data-sentinel-private"); }

export function sanitizeReplayEvent(raw: unknown, blockedIds: Set<number>, isPrivateId?: (id: number) => boolean, layoutForId?: (id: number) => string | undefined, presentation?: ReplayPresentation): SafeReplayEvent | null {
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
  const cleanNode = (rawNode: unknown, depth: number, parentTag = "", base?: string): Record<string, unknown> => {
    const node = obj(rawNode);
    if (!node || !id(node.id) || !Number.isInteger(node.type) || ++nodes > MAX_NODES) throw new Error("invalid node");
    const common = { id: node.id, type: node.type };
    if (depth >= MAX_DEPTH && node.type === 2) {
      // Keep the node identity for rrweb, but omit descendants that would
      // exceed Ingest's structural bound. Ignore later mutations under them.
      const pending = [node];
      while (pending.length) {
        const current = pending.pop()!;
        if (current !== node && ++nodes > MAX_NODES) throw new Error("too many nodes");
        if (id(current.id)) blockedIds.add(current.id);
        if (Array.isArray(current.childNodes)) {
          for (const child of current.childNodes) {
            const item = obj(child);
            if (item) pending.push(item);
          }
        }
      }
      return { id: node.id, type: 2, tagName: "div", attributes: {}, childNodes: [] };
    }
    if (node.type === 0) {
      if (!Array.isArray(node.childNodes)) throw new Error("invalid document");
      return { ...common, childNodes: node.childNodes.map(child => cleanNode(child, depth + 1)) };
    }
    if (node.type === 1) return { ...common, name: "html", publicId: "", systemId: "" };
    if (node.type === 3 || node.type === 4 || node.type === 5) return { ...common, textContent: node.type === 3 ? parentTag === "style" && presentation ? presentation.policy.css(node.textContent, false, base) : presentation?.textForId(node.id, typeof node.textContent === "string" ? node.textContent : "") ?? "*" : "" };
    if (node.type !== 2 || typeof node.tagName !== "string") throw new Error("invalid node type");
    const tag = node.tagName.toLowerCase();
    const attrs = obj(node.attributes);
    const privateNode = marker(attrs) || (isPrivateId?.(node.id) ?? false) || node.isShadowHost === true || node.isShadow === true ||
      (!(presentation && VISUAL_TAGS.has(tag)) && (UNSAFE_TAGS.has(tag) || !SAFE_TAGS.has(tag)));
    if (privateNode) {
      blockedIds.add(node.id);
      return { ...common, tagName: "div", attributes: {}, childNodes: [] };
    }
    if (!Array.isArray(node.childNodes)) throw new Error("invalid element");
    const cssBase = presentation?.baseForId(node.id);
    const style = layoutForId?.(node.id);
    const attributes = presentation ? presentation.policy.attributes(tag, attrs ?? {}, cssBase) : style ? { style } : {};
    if (presentation?.useFallback && style && !["style", "link"].includes(tag)) attributes.style = presentation.policy.css(`${style};${attributes.style ?? ""}`, true, cssBase);
    // Computed styles are a fallback for inaccessible stylesheets, not a fixed
    // override of responsive and dynamic source CSS when capture succeeds.
    return { ...common, tagName: tag, attributes, ...(node.isSVG === true ? { isSVG: true } : {}), childNodes: node.childNodes.map(child => cleanNode(child, depth + 1, tag, cssBase)) };
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
    if (event.type !== 3) return null;
    if (presentation && [1, 6, 12].includes(data.source as number) && Array.isArray(data.positions)) {
      const positions = data.positions.flatMap(value => {
        const point = obj(value);
        return point && id(point.id) && !blockedIds.has(point.id) && !isPrivateId?.(point.id) && coordinate(point.x) && coordinate(point.y) && coordinate(point.timeOffset)
          ? [{ id: point.id, x: point.x, y: point.y, timeOffset: point.timeOffset }] : [];
      });
      return positions.length ? { type: 3, timestamp, data: { source: data.source, positions } } : null;
    }
    if (presentation && [2, 3].includes(data.source as number) && id(data.id) && !blockedIds.has(data.id) && !isPrivateId?.(data.id) && coordinate(data.x) && coordinate(data.y)) {
      if (data.source === 2 && (!Number.isInteger(data.type) || (data.type as number) < 0 || (data.type as number) > 11)) return null;
      return { type: 3, timestamp, data: { source: data.source, id: data.id, x: data.x, y: data.y, ...(data.source === 2 ? { type: data.type } : {}) } };
    }
    if (presentation && data.source === 4 && coordinate(data.width) && coordinate(data.height)) return { type: 3, timestamp, data: { source: 4, width: data.width, height: data.height } };
    if (presentation && [8, 13].includes(data.source as number)) {
      if (!id(data.id) || blockedIds.has(data.id) || isPrivateId?.(data.id)) return null;
      const base = presentation.baseForId(data.id);
      if (data.source === 8) {
        const result: Record<string, unknown> = { source: 8, id: data.id };
        const validIndex = (index: unknown) => Number.isSafeInteger(index) && (index as number) >= 0 || Array.isArray(index) && index.length <= 16 && index.every(value => Number.isSafeInteger(value) && value >= 0);
        if (Array.isArray(data.adds)) result.adds = data.adds.flatMap(value => {
          const item = obj(value); if (!item || !validIndex(item.index)) return [];
          const rule = presentation.policy.css(item.rule, false, base);
          // Keep an empty safe rule for a removed declaration so subsequent
          // stylesheet indices remain aligned with the original sheet.
          return [{ rule: rule || ":root{}", index: item.index }];
        });
        if (Array.isArray(data.removes)) result.removes = data.removes.flatMap(value => { const item = obj(value); return item && validIndex(item.index) ? [{ index: item.index }] : []; });
        for (const key of ["replace", "replaceSync"]) if (typeof data[key] === "string") result[key] = presentation.policy.css(data[key], false, base);
        return { type: 3, timestamp, data: result };
      }
      if (!Array.isArray(data.index) || data.index.length > 16 || !data.index.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
      const set = obj(data.set), remove = obj(data.remove);
      if (set && typeof set.property === "string" && typeof set.value === "string") {
        const clean = presentation.policy.css(`${set.property}:${set.value}`, true, base);
        const colon = clean.indexOf(":");
        if (colon < 1) return null;
        return { type: 3, timestamp, data: { source: 13, id: data.id, index: data.index, set: { property: clean.slice(0, colon), value: clean.slice(colon + 1), priority: set.priority === "important" ? "important" : "" } } };
      }
      if (remove && typeof remove.property === "string" && /^[-\w]{1,128}$/.test(remove.property)) return { type: 3, timestamp, data: { source: 13, id: data.id, index: data.index, remove: { property: remove.property } } };
      return null;
    }
    if (data.source !== 0) return null;
    if (!Array.isArray(data.texts) || !Array.isArray(data.attributes) || !Array.isArray(data.removes) || !Array.isArray(data.adds)) return null;
    for (const value of data.attributes) {
      const item = obj(value);
      if (item && id(item.id) && marker(obj(item.attributes))) blockedIds.add(item.id);
    }
    const hidden = (value: unknown): boolean => id(value) && (blockedIds.has(value) || (isPrivateId?.(value) ?? false));
    const texts = data.texts.flatMap(value => {
      const item = obj(value);
      return item && id(item.id) && !hidden(item.id) ? [{ id: item.id, value: presentation?.textForId(item.id, typeof item.value === "string" ? item.value : "") ?? "*" }] : [];
    });
    // Never retain source attributes. Only recompute allowlisted presentation
    // for a surviving element when its class/style/layout attributes change.
    const attributes = data.attributes.flatMap(value => {
      const item = obj(value);
      if (!item || !id(item.id) || hidden(item.id)) return [];
      if (presentation) {
        const raw = { ...(obj(item.attributes) ?? {}) };
        if (raw.style && typeof raw.style === "object") raw.style = presentation.styleForId(item.id);
        const tag = presentation.tagForId(item.id);
        const attributes = presentation.policy.mutationAttributes(tag, raw, presentation.baseForId(item.id));
        return Object.keys(attributes).length ? [{ id: item.id, attributes }] : [];
      }
      const style = layoutForId?.(item.id);
      return style === undefined ? [] : [{ id: item.id, attributes: { style } }];
    });
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
    if (!texts.length && !attributes.length && !removes.length && !adds.length) return null;
    return { type: 3, timestamp, data: { source: 0, texts, attributes, removes, adds } };
  } catch { return null; }
}
