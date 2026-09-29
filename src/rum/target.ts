const MAX_ANCESTORS = 8;
const MAX_CHILD_NODES = 12;
const MAX_INSPECTED_NODES = 20;
const MAX_SOURCE_CHARS = 160;
const MAX_OUTPUT_BYTES = 80;
const HUMAN_WORDS = /^[\p{L}\p{M}]+(?:[ -][\p{L}\p{M}]+)*$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._+~-]+$/;
const INLINE_TEXT_TAGS = new Set(["SPAN", "STRONG", "B", "EM", "I", "SMALL"]);
const SENSITIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch"]);
const PRESENTATION_TAGS = new Set(["SPAN", "STRONG", "B", "EM", "I", "SMALL", "SVG", "G", "PATH", "USE"]);

export interface Target { tag?: string; role?: string; test_id?: string; label?: string; text?: string }
export interface ResolvedTarget { semantic: Target; element: Element; deadEligible: boolean }

function safeIdentifier(value: string | null): string | undefined {
  return value && value.length <= 128 && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

function humanText(value: string | null): string | undefined {
  if (!value || value.length > MAX_SOURCE_CHARS) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim().normalize("NFC");
  if (!normalized || !HUMAN_WORDS.test(normalized) || typeof TextEncoder === "undefined") return undefined;
  return new TextEncoder().encode(normalized).length <= MAX_OUTPUT_BYTES ? normalized : undefined;
}

function hidden(element: Element): boolean {
  return element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true";
}

function contentEditable(element: Element): boolean {
  return element instanceof HTMLElement ? element.isContentEditable : element.hasAttribute("contenteditable");
}

function visible(element: Element): boolean {
  if (hidden(element)) return false;
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  }
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0";
}

function interactive(element: Element): boolean {
  const tag = element.tagName;
  return tag === "BUTTON" || tag === "A" || SENSITIVE_TAGS.has(tag) || INTERACTIVE_ROLES.has(element.getAttribute("role") ?? "");
}

function smallControl(element: Element): boolean {
  const tag = element.tagName;
  const role = element.getAttribute("role");
  return tag === "BUTTON" || tag === "A" || INTERACTIVE_ROLES.has(role ?? "");
}

// Inspects only direct text and one level of simple formatting children.
function visibleControlText(element: Element): string | undefined {
  if (!visible(element) || element.childNodes.length > MAX_CHILD_NODES) return undefined;
  let source = "";
  let inspected = 0;
  for (const child of element.childNodes) {
    if (++inspected > MAX_INSPECTED_NODES) return undefined;
    if (child.nodeType === 3) {
      const part = child.nodeValue ?? "";
      if (source.length + part.length > MAX_SOURCE_CHARS) return undefined;
      source += part;
    } else if (child instanceof Element) {
      if (child.localName === "svg") continue;
      if (child.hasAttribute("data-sentinel-private")) return undefined;
      if (!INLINE_TEXT_TAGS.has(child.tagName) || contentEditable(child) || child.children.length || child.childNodes.length > 4) return undefined;
      if (!visible(child)) continue;
      for (const grandchild of child.childNodes) {
        if (++inspected > MAX_INSPECTED_NODES || grandchild.nodeType !== 3) return undefined;
        const part = grandchild.nodeValue ?? "";
        if (source.length + part.length > MAX_SOURCE_CHARS) return undefined;
        source += part;
      }
    } else if (child.nodeType !== 8) {
      return undefined;
    }
  }
  return humanText(source);
}

export function targetFor(value: EventTarget | null): ResolvedTarget | undefined {
  if (!(value instanceof Element)) return undefined;
  let current: Element | null = value;
  let resolved: Element | undefined;
  let testIdFallback: Element | undefined;
  let privateTarget = false;
  let sensitive = false;
  let hiddenAncestor = false;
  let insideFormOrAnchor = false;
  for (let i = 0; i < MAX_ANCESTORS && current; i++, current = current.parentElement) {
    privateTarget ||= current.hasAttribute("data-sentinel-private");
    sensitive ||= SENSITIVE_TAGS.has(current.tagName) || contentEditable(current);
    hiddenAncestor ||= hidden(current);
    insideFormOrAnchor ||= current.tagName === "FORM" || current.tagName === "A";
    if (!resolved && interactive(current)) resolved = current;
    if (!testIdFallback && current.hasAttribute("data-testid")) testIdFallback = current;
  }
  const element = resolved ?? testIdFallback ?? value;
  const tag = safeIdentifier(element.tagName.toLowerCase());
  const role = safeIdentifier(element.getAttribute("role")) ?? (tag === "button" ? "button" : undefined);
  const testId = safeIdentifier(element.getAttribute("data-testid"));
  const semantic: Target = { ...(tag ? { tag } : {}), ...(role ? { role } : {}), ...(testId ? { test_id: testId } : {}) };
  if (!Object.keys(semantic).length) return undefined;
  if (!privateTarget && !sensitive && !hiddenAncestor && smallControl(element) && visible(element)) {
    const label = humanText(element.getAttribute("aria-label"));
    if (label) semantic.label = label;
    else {
      const text = visibleControlText(element);
      if (text) semantic.text = text;
    }
  }
  const deadEligible = (element.tagName === "BUTTON" || element.getAttribute("role") === "button") &&
    !element.hasAttribute("disabled") && !insideFormOrAnchor && !sensitive;
  return { semantic, element, deadEligible };
}

// Pointer-only resolution. Generic elements never contribute readable text.
export function attemptTargetFor(value: EventTarget | null): ResolvedTarget | undefined {
  if (!(value instanceof Element)) return undefined;
  const ancestors: Element[] = [];
  let current: Element | null = value;
  for (let i = 0; i < MAX_ANCESTORS && current; i++, current = current.parentElement) {
    if (current.hasAttribute("data-sentinel-private") || hidden(current) || contentEditable(current) ||
      SENSITIVE_TAGS.has(current.tagName) || current.tagName === "LABEL") return undefined;
    ancestors.push(current);
  }
  const control = targetFor(value);
  if (control && interactive(control.element) && !SENSITIVE_TAGS.has(control.element.tagName)) {
    return visible(control.element) ? control : undefined;
  }
  // A generic target must have a complete bounded privacy walk.
  if (current || ancestors.some(element => element.tagName === "FORM")) return undefined;
  let candidate = value;
  for (const ancestor of ancestors.slice(0, 4)) {
    if (ancestor.tagName === "HTML" || ancestor.tagName === "BODY") break;
    if (safeIdentifier(ancestor.getAttribute("data-testid"))) { candidate = ancestor; break; }
    if (!PRESENTATION_TAGS.has(ancestor.tagName.toUpperCase())) { candidate = ancestor; break; }
  }
  if (candidate.tagName === "HTML" || candidate.tagName === "BODY" || !visible(candidate)) return undefined;
  const tag = safeIdentifier(candidate.tagName.toLowerCase());
  const role = safeIdentifier(candidate.getAttribute("role"));
  const testId = safeIdentifier(candidate.getAttribute("data-testid"));
  const semantic: Target = { ...(tag ? { tag } : {}), ...(role ? { role } : {}), ...(testId ? { test_id: testId } : {}) };
  return Object.keys(semantic).length ? { semantic, element: candidate, deadEligible: false } : undefined;
}
