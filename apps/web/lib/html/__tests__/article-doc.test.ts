import { describe, expect, it } from "vitest";
import { headingLevel, sanitizeArticleDoc } from "../article-doc";

// The editor's JSON held to the sanitiser's rules before it is stored: the
// same check on an editor save (updateArticle) and on the model's import
// (htmlToTiptapJson).

const doc = (...content: unknown[]) => ({ type: "doc", content });
const text = (t: string, marks?: unknown[]) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const link = (href: unknown) => ({ type: "link", attrs: { href, target: "_blank", rel: "noopener" } });

describe("sanitizeArticleDoc", () => {
  it("leaves an ordinary article as it was", () => {
    const input = doc(
      { type: "heading", attrs: { level: 2, id: "pricing" }, content: [text("Pricing")] },
      { type: "paragraph", content: [text("See "), text("this", [link("https://ok.example/x?a=1&amp;b=2")]), text(" and "), text("that", [{ type: "bold" }, link("/pricing")])] },
      { type: "image", attrs: { src: "https://cdn.example/x.webp", alt: "A", title: null, caption: "Cap" } },
      { type: "iframe", attrs: { src: "https://www.youtube-nocookie.com/embed/v1", title: "T" } },
      { type: "svgFigure", attrs: { svg: '<svg viewBox="0 0 1 1"><rect width="1" height="1"></rect></svg>', caption: "Src" } },
    );
    expect(sanitizeArticleDoc(input)).toEqual(input);
  });

  it("drops a link mark whose target is not a page, and keeps its text", () => {
    for (const href of ["javascript:alert(1)", "jav&#x61;script:alert(1)", "data:text/html,x", "", 42]) {
      const out = sanitizeArticleDoc(doc({ type: "paragraph", content: [text("x", [{ type: "bold" }, link(href)])] }));
      expect(out.content?.[0].content?.[0], String(href)).toEqual({ type: "text", text: "x", marks: [{ type: "bold" }] });
    }
  });

  it("drops an image, an embed or a figure that does not pass", () => {
    const out = sanitizeArticleDoc(
      doc(
        { type: "image", attrs: { src: "javascript:alert(1)" } },
        { type: "image", attrs: { src: "data:image/svg+xml,<svg onload=alert(1)>" } },
        { type: "iframe", attrs: { src: "https://evil.example/embed/x" } },
        { type: "svgFigure", attrs: { svg: "<svg></svg><img/src=x/onerror=alert(1)><svg></svg>" } },
        { type: "paragraph", content: [text("kept")] },
      ),
    );
    expect(out.content).toEqual([{ type: "paragraph", content: [text("kept")] }]);
  });

  it("stores an inline SVG figure rebuilt from the allowlist", () => {
    const out = sanitizeArticleDoc(doc({ type: "svgFigure", attrs: { svg: '<svg/onload=alert(1)><rect width="1"/></svg>' } }));
    expect(out.content?.[0].attrs?.svg).toBe('<svg><rect width="1"></rect></svg>');
  });

  it("clamps a heading level and drops an id that is not an id", () => {
    const out = sanitizeArticleDoc(
      doc(
        { type: "heading", attrs: { level: "2 onmouseover=alert(1)", id: 'x" onclick="y' } },
        { type: "heading", attrs: { level: 9 } },
        { type: "heading", attrs: { level: 3 } },
      ),
    );
    expect(out.content?.map((n) => n.attrs)).toEqual([{ level: 2 }, { level: 2 }, { level: 3 }]);
  });

  it("refuses something that is not a document", () => {
    expect(() => sanitizeArticleDoc("<p>x</p>")).toThrow("must be a document");
    expect(() => sanitizeArticleDoc(null)).toThrow("must be a document");
    expect(() => sanitizeArticleDoc({ type: "paragraph" })).toThrow("must be a document");
  });

  it("drops nodes that are not nodes", () => {
    expect(sanitizeArticleDoc(doc("x", null, { type: "paragraph" }))).toEqual(doc({ type: "paragraph" }));
  });
});

describe("headingLevel", () => {
  it("is an integer from 1 to 6, 2 otherwise", () => {
    expect([1, 6, "3", 0, 7, 2.5, "2 x", null, undefined].map(headingLevel)).toEqual([1, 6, 3, 2, 2, 2, 2, 2, 2]);
  });
});
