import { parse, generate, walk, type CssNode, type List, type ListItem } from "css-tree";

export interface VisualPolicy {
  url(value: unknown, base?: string): string | undefined;
  css(value: unknown, declarations?: boolean, base?: string): string;
  attributes(tag: string, value: Record<string, unknown>, base?: string): Record<string, string>;
  mutationAttributes(tag: string, value: Record<string, unknown>, base?: string): Record<string, string | null>;
}
const queryKeys = new Set("w h width height q quality format fm fit crop dpr v version auto ixlib".split(" "));
const visualNames = new Set("class id role dir lang width height colspan rowspan span media sizes type data-theme data-state data-open aria-expanded aria-hidden".split(" "));
const vectorNames = new Set("viewBox viewbox d points x y x1 y1 x2 y2 cx cy r rx ry stroke-width stroke-linecap stroke-linejoin fill-rule clip-rule opacity transform preserveAspectRatio".split(" "));
const groups = new Set(["media", "supports", "layer", "container", "keyframes", "-webkit-keyframes", "font-face"]);
const safeFunctions = new Set("var calc min max clamp rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix linear-gradient repeating-linear-gradient radial-gradient repeating-radial-gradient conic-gradient repeating-conic-gradient image-set -webkit-image-set translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d rotate rotatex rotatey rotatez rotate3d skew skewx skewy matrix matrix3d perspective cubic-bezier steps repeat minmax fit-content format tech local env counter counters".split(" "));

export function resourceOrigins(values: readonly string[]): string[] {
  if (values.length > 20) throw new Error("Too many replay resource origins");
  return [...new Set(values.map(value => {
    const url = new URL(value);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
        url.hostname.includes("*") || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid replay resource origin");
    return url.origin;
  }))];
}

export function createVisualPolicy(origins: readonly string[], baseUrl = "about:blank"): VisualPolicy {
  const allowed = new Set(resourceOrigins(origins));
  const url = (value: unknown, base = baseUrl, depth = 0): string | undefined => {
    if (typeof value !== "string" || !value || value.length > 4096 || [...value].some(char=>char.charCodeAt(0)<=32||char.charCodeAt(0)===127||char==="\\")) return undefined;
    if (/^#[\w-]{1,128}$/.test(value)) return value;
    try {
      const parsed = new URL(value, base);
      if (!allowed.has(parsed.origin) || parsed.username || parsed.password || !["https:", "http:"].includes(parsed.protocol)) return undefined;
      for (const [key, item] of parsed.searchParams) {
        if (["url", "src"].includes(key)) { if (depth >= 2 || !url(item, parsed.origin + "/", depth + 1)) return undefined; }
        else if (key === "family") { if (!/^[A-Za-z0-9 :;@,.|_-]{1,256}$/.test(item)) return undefined; }
        else if (key === "display") { if (!["auto", "block", "swap", "fallback", "optional"].includes(item)) return undefined; }
        else if (key === "subset") { if (!/^[A-Za-z,-]{1,128}$/.test(item)) return undefined; }
        else if (!queryKeys.has(key) || !/^[\w.,-]{1,128}$/.test(item)) return undefined;
      }
      if (parsed.hash && !/^#[\w-]{1,128}$/.test(parsed.hash)) return undefined;
      return parsed.href;
    } catch { return undefined; }
  };
  const css = (value: unknown, declarations = false, base = baseUrl): string => {
    if (typeof value !== "string" || value.length > 750_000) return "";
    try {
      const tree = parse(value, { context: declarations ? "declarationList" : "stylesheet", parseCustomProperty: true, onParseError: () => {} });
      // Grid area rows are structural identifiers, not generated page text.
      const gridAreaRow = (value: string): boolean => value.length <= 2048 && !!value.trim() &&
        value.trim().split(/\s+/).every(name => /^(?:[A-Za-z_][\w-]*|\.+)$/.test(name));
      const safeValue = (node: CssNode, property: string): boolean => {
        let safe = !["behavior", "-moz-binding", "content"].includes(property);
        walk(node, function(child) {
          if (child.type === "Raw") safe = false;
          if (child.type === "Url") {
            const clean = url(child.value, base);
            if (!clean) safe = false; else child.value = clean;
          }
          if (child.type === "Function" && !safeFunctions.has(child.name.toLowerCase())) safe = false;
          if (child.type === "String" && ["image-set", "-webkit-image-set"].includes(this.function?.name ?? "")) {
            const clean = url(child.value, base);
            if (!clean) safe = false; else child.value = clean;
          } else if (child.type === "String" && !["font-family", "src"].includes(property) &&
              !(property === "grid-template-areas" && gridAreaRow(child.value))) safe = false;
        });
        return safe;
      };
      walk(tree, { enter(node: CssNode, item: ListItem<CssNode>, list: List<CssNode>) {
        if (node.type === "Raw") { if (item && list) list.remove(item); return walk.skip; }
        if (node.type === "Atrule" && (!groups.has(node.name.toLowerCase()) || !node.block && node.name.toLowerCase() !== "layer")) {
          if (item && list) item.data = (parse(":root{}") as { children: List<CssNode> }).children.first!;
          return walk.skip;
        }
        if (node.type === "Rule" && node.prelude) {
          let safe = true;
          walk(node.prelude, selector => {
            if (selector.type === "Raw") safe = false;
            if (selector.type === "AttributeSelector" && !visualNames.has(generate(selector.name))) safe = false;
          });
          if (!safe) { if (item && list) item.data = (parse(":root{}") as { children: List<CssNode> }).children.first!; return walk.skip; }
        }
        if (node.type === "Declaration" && !safeValue(node.value, node.property.toLowerCase())) { if (item && list) list.remove(item); return walk.skip; }
      } });
      return generate(tree);
    } catch { return ""; }
  };
  const attributes = (tag: string, raw: Record<string, unknown>, base = baseUrl): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== "string" && typeof value !== "number") continue;
      const text = String(value);
      if (visualNames.has(key) && text.length <= 2048 && ![...text].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)) result[key] = text;
      if (vectorNames.has(key) && text.length < 50_000 && /^[\w\s.,()+%-]*$/.test(text)) result[key] = text;
      if (["fill", "stroke", "clip-path"].includes(key)) {
        const clean = css(`${key}:${text}`, true, base);
        if (clean.startsWith(`${key}:`)) result[key] = clean.slice(key.length + 1);
      }
    }
    if (raw.style) { const clean = css(raw.style, true, base); if (clean) result.style = clean; }
    if (["style", "link"].includes(tag) && raw._cssText) result._cssText = css(raw._cssText, false, base);
    if (tag === "img") {
      const src = url(raw.src, base); if (src && !src.startsWith("#")) result.src = src;
      if (typeof raw.srcset === "string" && raw.srcset.length <= 8192) {
        const candidates = raw.srcset.split(",").flatMap(part => {
          const [source, descriptor, extra] = part.trim().split(/\s+/);
          const clean = url(source, base);
          return clean && !clean.startsWith("#") && !extra && (!descriptor || /^\d+(?:\.\d+)?[wx]$/.test(descriptor)) ? [`${clean}${descriptor ? ` ${descriptor}` : ""}`] : [];
        });
        if (candidates.length) result.srcset = candidates.join(",");
      }
      result.crossorigin = "anonymous"; result.referrerpolicy = "no-referrer";
    }
    if (tag === "link" && !result._cssText && raw.rel === "stylesheet") {
      const href = url(raw.href, base);
      if (href && !href.startsWith("#")) { result.rel = "stylesheet"; result.href = href; result.crossorigin = "anonymous"; result.referrerpolicy = "no-referrer"; }
    }
    if (tag === "use" && typeof raw.href === "string" && /^#[\w-]{1,128}$/.test(raw.href)) result.href = raw.href;
    if (tag === "input") result.type = typeof raw.type === "string" && ["text", "password", "email", "number", "search", "checkbox", "radio", "button", "submit", "date", "tel", "url"].includes(raw.type) ? raw.type : "text";
    for (const key of ["disabled", "readonly", "multiple"]) if (Object.prototype.hasOwnProperty.call(raw, key)) result[key] = "";
    return result;
  };
  const mutationAttributes = (tag: string, raw: Record<string, unknown>, base = baseUrl): Record<string, string | null> => {
    const clean: Record<string, string | null> = attributes(tag, raw, base);
    for (const [key, value] of Object.entries(raw)) {
      const resource = tag === "img" && ["src", "srcset"].includes(key) || ["link", "use"].includes(tag) && key === "href";
      if (resource && !Object.prototype.hasOwnProperty.call(clean, key)) clean[key] = null;
      if ((visualNames.has(key) || vectorNames.has(key) || ["style", "_cssText", "fill", "stroke", "clip-path"].includes(key)) && (value === null || value === "")) clean[key] = null;
    }
    return clean;
  };
  return { url, css, attributes, mutationAttributes };
}
