import { describe, expect, it } from "vitest";
import { layoutStyle } from "../../src/replay/layout";

const computed = (values: Record<string, string>) => ({ getPropertyValue: (key: string) => values[key] ?? "" });

describe("replay layout allowlist", () => {
  it("preserves resolved layout and colors without retaining source CSS or URLs", () => {
    const result = layoutStyle(computed({ display: "flex", width: "800px", height: "120px", "background-color": "rgb(12, 34, 56)",
      "grid-template-columns": "100px 200px", "font-size": "24px", "background-image": 'url(https://secret.test)',
      content: '"private text"', "font-family": "private-name", "--secret": "token", color: 'var(--secret)' }));
    expect(result).toContain("display:flex");
    expect(result).toContain("background-color:rgb(12, 34, 56)");
    expect(result).toContain("grid-template-columns:100px 200px");
    expect(result).not.toMatch(/secret|private|url|content:|font-family|var\(/);
  });

  it("rejects resources, CSS escapes, arbitrary identifiers and declaration injection", () => {
    for (const hostile of ['url(https://secret.test)', '1px;background:url(https://secret.test)', 'expression(alert(1))',
      'var(--secret)', '\\75rl(https://secret.test)', 'attr(data-secret)', '"secret"', '1px/*secret*/']) {
      expect(layoutStyle(computed({ width: hostile, color: hostile, display: hostile, opacity: hostile, "grid-template-columns": hostile }))).toBe("");
    }
    expect(layoutStyle(computed({ width: "0px", height: "0px", display: "none" }))).toBe("width:0px;height:0px;display:none");
  });
});
