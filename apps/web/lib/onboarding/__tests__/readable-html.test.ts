import { describe, expect, it } from "vitest";
import { readableHtml, safeUrl } from "../readable-html";

// The gate's reader puts this into the owner's page as HTML. Pinned: the four
// payloads that walked through the first, regex-stripping version; nothing
// outside the allowlist survives in any spelling; the article itself does.

describe("the reader's HTML, rebuilt from an allowlist", () => {
  it("lets none of the payloads that walked through the regex version run", () => {
    const cases = [
      "<img/src=x/onerror=alert(1)>",
      "<svg/onload=alert(1)>",
      "<a href=javascript:alert(1)>x</a>",
      '<a href="java&#x73;cript:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="jav&Tab;ascript:alert(1)">x</a>',
      '<a href=" javascript:alert(1)">x</a>',
      "<iframe/src=javascript:alert(1)></iframe>",
      "<details open ontoggle=alert(1)>",
      '<p style="background:url(javascript:alert(1))" onmouseover="x()">t</p>',
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      "<math><mi xlink:href=\"javascript:alert(1)\">x</mi></math>",
      '<img src="https://ok.example/a.png" onerror="alert(1)">',
      "<scr<script>ipt>alert(1)</script>",
      '<p title="a>b" onclick="x()">t</p>',
      "<!--><img src=x onerror=alert(1)>-->",
    ];
    for (const payload of cases) {
      const out = readableHtml(payload);
      expect(out, payload).not.toMatch(/\son[a-z]+\s*=/i);
      expect(out, payload).not.toMatch(/javascript:|data:text|<script|<svg|<iframe|<math|<details|style=/i);
    }
    expect(readableHtml('<img src="https://ok.example/a.png" onerror="alert(1)">')).toBe('<img src="https://ok.example/a.png">');
    expect(readableHtml("<a href=javascript:alert(1)>x</a>")).toBe("<a>x</a>");
  });

  it("keeps an article's own markup, links and tables", () => {
    const article = '<h2>Section</h2><p>Read <a href="https://ok.example/x?a=1&amp;b=2">this</a> &amp; <strong>that</strong>.</p><ul><li>one</li></ul><table><tr><td colspan="2">c</td></tr></table>';
    expect(readableHtml(article)).toBe('<h2>Section</h2><p>Read <a href="https://ok.example/x?a=1&amp;b=2" rel="nofollow noopener noreferrer">this</a> &amp; <strong>that</strong>.</p><ul><li>one</li></ul><table><tr><td colspan="2">c</td></tr></table>');
    expect(readableHtml('<p><a href="/pricing">pricing</a></p>')).toBe('<p><a href="/pricing" rel="nofollow noopener noreferrer">pricing</a></p>');
  });

  it("escapes stray text, closes what a half-written body left open, and hides a half-written tag", () => {
    expect(readableHtml("<p>1 < 2 & 3 > 2")).toBe("<p>1 &lt; 2 &amp; 3 &gt; 2</p>");
    expect(readableHtml('<p>Being writ<a href="https://ok.exa')).toBe("<p>Being writ</p>");
    expect(readableHtml("<p><em>open</p>")).toBe("<p><em>open</em></p>");
    expect(readableHtml("</div><p>x</p></p>")).toBe("<p>x</p>");
  });

  it("drops the writer's scaffolding: a fence, its h1, its meta description, link placeholders", () => {
    const out = readableHtml("```html\n<h1>Title</h1><meta-description>m</meta-description><p>See {{internal-link:pricing guide}}.</p>");
    expect(out).toBe("<p>See pricing guide.</p>");
  });

  it("reads a link's scheme the way a browser does", () => {
    expect(safeUrl("https://ok.example")).toBe("https://ok.example");
    expect(safeUrl("mailto:a@ok.example")).toBe("mailto:a@ok.example");
    expect(safeUrl("/a:b")).toBe("/a:b");
    expect(safeUrl("java\nscript:alert(1)")).toBeNull();
    expect(safeUrl("JaVaScRiPt&colon;alert(1)")).toBeNull();
    expect(safeUrl("vbscript:x")).toBeNull();
    expect(safeUrl("/x.png", { images: true })).toBeNull();
  });
});
