import { describe, expect, it } from "vitest";
import { tiptapToHtml } from "../html";

// What the publish serialiser writes for a link, an image, an embed, a heading
// and an inline chart is held to the same rules the editor shows: the
// reviewer must not approve one link and the site serve another.

const para = (href: unknown) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "go", marks: [{ type: "link", attrs: { href } }] }] }],
});
const one = (node: Record<string, unknown>) => tiptapToHtml({ type: "doc", content: [node] });

describe("tiptapToHtml: scheme allowlist", () => {
  it("publishes http(s), mailto, tel, relative and fragment links", () => {
    for (const href of ["https://ok.example/a", "http://ok.example", "mailto:a@ok.example", "tel:+391234", "/pricing", "#faq"]) {
      expect(tiptapToHtml(para(href)), href).toBe(`<p><a href="${href}">go</a></p>`);
    }
  });

  it("publishes a link with any other scheme as its text alone", () => {
    for (const href of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "java\tscript:alert(1)", "jav&#x61;script:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "", null]) {
      expect(tiptapToHtml(para(href)), String(href)).toBe("<p>go</p>");
    }
  });

  it("refuses a scheme spelled with zero-padded numeric references", () => {
    for (const href of ["javascript&#000000058;alert(1)", "javascript&#x00000003a;alert(1)", "javascript&#0000000000058;alert(1)"]) {
      expect(tiptapToHtml(para(href)), href).toBe("<p>go</p>");
      expect(one({ type: "image", attrs: { src: href, alt: "A" } }), href).toBe("");
    }
  });

  it("escapes what is left of an href so it cannot leave its attribute", () => {
    expect(tiptapToHtml(para('https://ok.example/"><script>x</script>'))).toBe(
      '<p><a href="https://ok.example/&quot;&gt;&lt;script&gt;x&lt;/script&gt;">go</a></p>',
    );
  });

  it("publishes an image only from http(s) or a relative path", () => {
    expect(one({ type: "image", attrs: { src: "https://cdn.example/a.webp", alt: "A" } })).toBe('<img src="https://cdn.example/a.webp" alt="A" />');
    expect(one({ type: "image", attrs: { src: "/a.webp", alt: "A" } })).toBe('<img src="/a.webp" alt="A" />');
    expect(one({ type: "image", attrs: { src: "javascript:alert(1)", alt: "A" } })).toBe("");
    expect(one({ type: "image", attrs: { src: "data:image/svg+xml,<svg onload=alert(1)>", alt: "A" } })).toBe("");
  });

  it("clamps a heading level to an integer from 1 to 6", () => {
    const h = (level: unknown) => one({ type: "heading", attrs: { level }, content: [{ type: "text", text: "T" }] });
    expect(h(3)).toBe("<h3>T</h3>");
    expect(h("2 onmouseover=alert(1)")).toBe("<h2>T</h2>");
    expect(h(9)).toBe("<h2>T</h2>");
    expect(h(undefined)).toBe("<h2>T</h2>");
  });

  it("publishes an inline chart rebuilt from the SVG allowlist", () => {
    expect(one({ type: "svgFigure", attrs: { svg: '<svg/onload=alert(1)><rect width="1"/></svg>' } })).toBe(
      '<figure class="infographic"><svg><rect width="1"></rect></svg></figure>',
    );
    expect(one({ type: "svgFigure", attrs: { svg: "<svg></svg><img/src=x/onerror=alert(1)><svg></svg>" } })).toBe("");
    expect(one({ type: "svgFigure", attrs: { svg: '<svg><style>body{display:none}</style><rect width="1"/></svg>' } })).toBe(
      '<figure class="infographic"><svg><rect width="1"></rect></svg></figure>',
    );
  });
});
