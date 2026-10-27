// Capture resolved presentation, never source CSS, selectors, attributes or URLs.
// The player remains offline; images, fonts, generated content and CSS resources
// are deliberately absent from this allowlist.
const dimensions = new Set(("width height min-width min-height max-width max-height top right bottom left margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left border-top-width border-right-width border-bottom-width border-left-width border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius font-size line-height letter-spacing row-gap column-gap flex-basis").split(" "));
const colors = new Set(["color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color"]);
const keywords: Record<string, readonly string[]> = {
  display: ["none", "block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "list-item", "table", "table-row", "table-cell", "table-row-group", "table-header-group", "table-footer-group"],
  position: ["static", "relative", "absolute", "fixed", "sticky"],
  "box-sizing": ["content-box", "border-box"],
  "flex-direction": ["row", "row-reverse", "column", "column-reverse"],
  "flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
  "justify-content": ["normal", "start", "end", "flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly", "stretch"],
  "align-items": ["normal", "start", "end", "flex-start", "flex-end", "center", "stretch", "baseline"],
  "align-self": ["auto", "normal", "start", "end", "flex-start", "flex-end", "center", "stretch", "baseline"],
  "text-align": ["start", "end", "left", "right", "center", "justify"],
  "white-space": ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"],
  "font-style": ["normal", "italic", "oblique"],
  "font-weight": ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
  "overflow-x": ["visible", "hidden", "clip", "scroll", "auto"],
  "overflow-y": ["visible", "hidden", "clip", "scroll", "auto"],
  visibility: ["visible", "hidden", "collapse"],
  "border-top-style": ["none", "solid", "dashed", "dotted", "double"],
  "border-right-style": ["none", "solid", "dashed", "dotted", "double"],
  "border-bottom-style": ["none", "solid", "dashed", "dotted", "double"],
  "border-left-style": ["none", "solid", "dashed", "dotted", "double"],
};
const numbers = new Set(["opacity", "flex-grow", "flex-shrink", "order", "z-index"]);
const tracks = new Set(["grid-template-columns", "grid-template-rows"]);
const omitted = new Set(["0px", "none", "auto", "normal", "static", "visible", "content-box", "nowrap", "row", "start", "rgba(0, 0, 0, 0)"]);
const length = /^-?\d+(?:\.\d+)?(?:px|%|em|rem|vh|vw|vmin|vmax)?$/;

type StyleValues = Pick<CSSStyleDeclaration, "getPropertyValue">;
export function layoutStyle(style: StyleValues, parent?: StyleValues, tag = ""): string {
  const declarations: string[] = [];
  const grouped = new Set<string>();
  for (const box of ["margin", "padding"]) {
    const properties = ["top", "right", "bottom", "left"].map(side => `${box}-${side}`);
    const values = properties.map(property => style.getPropertyValue(property).trim());
    if (values.every(value => length.test(value))) {
      const [top, right, bottom, left] = values;
      declarations.push(`${box}:${top === right && top === bottom && top === left ? top : top === bottom && right === left ? `${top} ${right}` : values.join(" ")}`);
      properties.forEach(property => grouped.add(property));
    }
  }
  for (const property of [...dimensions, ...colors, ...Object.keys(keywords), ...numbers, ...tracks]) {
    if (grouped.has(property)) continue;
    if (/^border-(top|right|bottom|left)-color$/.test(property) && style.getPropertyValue(property.replace("color", "width")) === "0px") continue;
    const value = style.getPropertyValue(property).trim();
    if (!value || value.length > 160) continue;
    if ((["opacity", "flex-shrink"].includes(property) && value === "1") || (["flex-grow", "order"].includes(property) && value === "0")) continue;
    const inherited = ["color", "font-size", "line-height", "letter-spacing", "font-weight", "font-style", "text-align", "white-space", "visibility"].includes(property);
    // Do not confuse inherited values with browser tag defaults (heading size,
    // link color, bold/emphasis, preformatted text or centered table headers).
    const nativeOverride = /^(?:h[1-6]|small|strong|b|em|i|pre|code|th|a)$/.test(tag);
    if (inherited && parent && !nativeOverride && value === parent.getPropertyValue(property).trim()) continue;
    const valid = dimensions.has(property) ? length.test(value) || ["auto", "none", "normal", "min-content", "max-content", "fit-content"].includes(value)
      : colors.has(property) ? /^(?:rgba?\([\d.,% /]+\)|transparent|currentcolor|#[\da-f]{3,8})$/i.test(value)
      : numbers.has(property) ? /^-?\d+(?:\.\d+)?$/.test(value) && Math.abs(Number(value)) <= 1_000_000
      : tracks.has(property) ? value.split(" ").every(part => length.test(part))
      : keywords[property]?.includes(value);
    // Keep dimensions and display even when zero/none. They preserve empty and
    // hidden elements after text masking. Other common defaults need no bytes.
    if (valid && (!omitted.has(value) || ["width", "height", "display"].includes(property))) declarations.push(`${property}:${value}`);
  }
  return declarations.join(";");
}

export function captureLayout(node: Node | null): string | undefined {
  if (!node || node.nodeType !== 1) return undefined;
  const element = node as Element;
  const view = element.ownerDocument.defaultView;
  if (!view) return undefined;
  try {
    const tag = element.tagName.toLowerCase();
    const style = layoutStyle(view.getComputedStyle(element), element.parentElement ? view.getComputedStyle(element.parentElement) : undefined, tag);
    return tag === "html" ? `${style};font-family:system-ui` : style;
  } catch { return undefined; }
}
