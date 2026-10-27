import { describe, expect, it } from "vitest";
import { createVisualPolicy, resourceOrigins } from "../../src/replay/visual-policy";

describe("visual replay public resource policy",()=>{
  const policy=createVisualPolicy(["https://static.example.test"],"https://static.example.test/css/site.css");
  it("resolves CSS assets and retains typography, grid, variables and media rules",()=>{
    const css=policy.css('@font-face{font-family:"Brand";src:url(../font.woff2) format("woff2")} @media(min-width:600px){.card{--gap:16px;display:grid;gap:var(--gap);background:url(/image.png);font-family:"Brand"}}');
    expect(css).toContain("https://static.example.test/font.woff2");
    expect(css).toContain("display:grid");expect(css).toContain("var(--gap)");
  });
  it("rejects arbitrary origins, credentials, signed/token URLs and unsafe protocols",()=>{
    for(const url of ["javascript:alert(1)","data:image/png;base64,abc","https://evil.test/x","https://user:pass@static.example.test/x","https://static.example.test/x?token=secret","https://static.example.test/x?email=secret"])
      expect(policy.url(url)).toBeUndefined();
    expect(policy.url("/image?w=120&q=80")).toBe("https://static.example.test/image?w=120&q=80");
    expect(policy.url("/_next/image?url=%2Fphoto.jpg&w=640&q=75")).toContain("/_next/image?");
    expect(policy.url("/_next/image?url=https%3A%2F%2Fevil.test%2Fsecret&w=640")).toBeUndefined();
    expect(()=>resourceOrigins(["https://*.example.test"])).toThrow();
  });
  it("parses escapes and removes imports, exfiltration, content and executable CSS",()=>{
    const css=policy.css('@import "https://evil.test/x";.x{background:u\\72l(https://evil.test/x);content:"secret";width:expression(alert(1));--leak:"secret";color:red}.x[data-secret="secret"]{color:blue}');
    expect(css).not.toMatch(/evil|secret|expression|@import/);expect(css).toContain("color:red");
    const attrs=policy.attributes("img",{src:"/image.png",onclick:"secret",title:"secret",class:"card",value:"secret"});
    expect(attrs.class).toBe("card");expect(attrs.crossorigin).toBe("anonymous");expect(JSON.stringify(attrs)).not.toContain("secret");
  });
  it("clears removed styles/classes and rejects replacement resource URLs without leaving stale attributes",()=>{
    const clean=policy.mutationAttributes("img",{style:"",class:null,src:"javascript:alert(1)",srcset:null,onclick:null});
    expect(clean.style).toBeNull();expect(clean.class).toBeNull();expect(clean.src).toBeNull();expect(clean.srcset).toBeNull();expect(clean).not.toHaveProperty("onclick");
  });
});
