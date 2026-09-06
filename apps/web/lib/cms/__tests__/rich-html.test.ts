import { describe, it, expect } from "vitest";
import {
  parseRichHtml,
  hasReadableContent,
  spansToPlainText,
  decodeEntities,
} from "../rich-html";
import { tiptapToHtml } from "../html";

describe("parseRichHtml", () => {
  it("keeps a paragraph that contains a link, with the link on its own span", () => {
    // The bug this file exists for: the old regex `([^<]*)` matched nothing
    // here and the paragraph vanished from the article.
    const blocks = parseRichHtml(
      '<p>Read our <a href="https://example.com/guide">guide to schema</a> next.</p>',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    if (blocks[0].type !== "paragraph") return;
    expect(spansToPlainText(blocks[0].spans)).toBe("Read our guide to schema next.");
    expect(blocks[0].spans).toEqual([
      { text: "Read our " },
      { text: "guide to schema", href: "https://example.com/guide" },
      { text: " next." },
    ]);
  });

  it("keeps bold, italic and inline code inside a paragraph", () => {
    const blocks = parseRichHtml(
      "<p>A <strong>bold</strong> and <em>italic</em> and <code>npm run dev</code>.</p>",
    );
    if (blocks[0].type !== "paragraph") throw new Error("expected paragraph");
    expect(blocks[0].spans).toEqual([
      { text: "A " },
      { text: "bold", bold: true },
      { text: " and " },
      { text: "italic", italic: true },
      { text: " and " },
      { text: "npm run dev", code: true },
      { text: "." },
    ]);
  });

  it("nests styling: a bold link keeps both", () => {
    const blocks = parseRichHtml('<p><a href="/x"><strong>Both</strong></a></p>');
    if (blocks[0].type !== "paragraph") throw new Error("expected paragraph");
    expect(blocks[0].spans).toEqual([{ text: "Both", href: "/x", bold: true }]);
  });

  it("reads headings at their own level", () => {
    const blocks = parseRichHtml("<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4>");
    expect(blocks.map((b) => (b.type === "heading" ? b.level : null))).toEqual([1, 2, 3, 4]);
  });

  it("keeps list items as list items, with their ordering and depth", () => {
    const blocks = parseRichHtml(
      "<ul><li>first</li><li>second</li></ul><ol><li>a</li></ol>",
    );
    expect(blocks).toEqual([
      { type: "listItem", ordered: false, depth: 0, spans: [{ text: "first" }] },
      { type: "listItem", ordered: false, depth: 0, spans: [{ text: "second" }] },
      { type: "listItem", ordered: true, depth: 0, spans: [{ text: "a" }] },
    ]);
  });

  it("records the depth of a nested list", () => {
    const blocks = parseRichHtml("<ul><li>outer<ul><li>inner</li></ul></li></ul>");
    const depths = blocks.filter((b) => b.type === "listItem").map((b) => (b.type === "listItem" ? b.depth : -1));
    expect(depths).toEqual([0, 1]);
  });

  it("keeps a blockquote's paragraphs as quote blocks", () => {
    const blocks = parseRichHtml("<blockquote><p>Quoted <em>words</em></p></blockquote><p>After</p>");
    expect(blocks.map((b) => b.type)).toEqual(["quote", "paragraph"]);
  });

  it("keeps a code block verbatim, without inline styling", () => {
    const blocks = parseRichHtml("<pre><code>const a = 1 &lt; 2;\nreturn a;</code></pre>");
    expect(blocks).toEqual([{ type: "code", text: "const a = 1 < 2;\nreturn a;" }]);
  });

  it("reads an image and attaches its figcaption", () => {
    const blocks = parseRichHtml(
      '<figure class="article-image"><img src="https://cdn.example.com/a.png" alt="A chart" /><figcaption>Source: us</figcaption></figure>',
    );
    expect(blocks).toEqual([
      { type: "image", src: "https://cdn.example.com/a.png", alt: "A chart", caption: "Source: us" },
    ]);
  });

  it("reads a YouTube embed as an embed block", () => {
    const blocks = parseRichHtml(
      '<figure class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/abc" title="t"></iframe></figure>',
    );
    expect(blocks).toEqual([{ type: "embed", src: "https://www.youtube-nocookie.com/embed/abc" }]);
  });

  it("reports an inline SVG figure as unsupported rather than flattening it to markup", () => {
    const blocks = parseRichHtml(
      '<figure class="infographic"><svg viewBox="0 0 10 10"><text>hi</text></svg><figcaption>Chart</figcaption></figure>',
    );
    expect(blocks).toEqual([{ type: "unsupported", tag: "svg", caption: "Chart" }]);
  });

  it("keeps a table's cells and marks the header row", () => {
    const blocks = parseRichHtml(
      "<table><tr><th>Tool</th><th>Price</th></tr><tr><td>AltoRank</td><td>29</td></tr></table>",
    );
    expect(blocks).toHaveLength(1);
    if (blocks[0].type !== "table") throw new Error("expected table");
    expect(blocks[0].rows).toHaveLength(2);
    expect(blocks[0].rows[0].every((c) => c.header)).toBe(true);
    expect(blocks[0].rows[1].map((c) => spansToPlainText(c.spans))).toEqual(["AltoRank", "29"]);
  });

  it("turns a horizontal rule into a divider", () => {
    expect(parseRichHtml("<p>a</p><hr /><p>b</p>").map((b) => b.type)).toEqual([
      "paragraph",
      "divider",
      "paragraph",
    ]);
  });

  it("keeps a hard break inside a paragraph", () => {
    const blocks = parseRichHtml("<p>one<br />two</p>");
    if (blocks[0].type !== "paragraph") throw new Error("expected paragraph");
    expect(spansToPlainText(blocks[0].spans)).toBe("one\ntwo");
  });

  it("decodes entities in text and in attributes", () => {
    const blocks = parseRichHtml('<p>Caf&eacute; &amp; co &#8212; 5 &lt; 6</p>');
    if (blocks[0].type !== "paragraph") throw new Error("expected paragraph");
    expect(spansToPlainText(blocks[0].spans)).toBe("Café & co — 5 < 6");
  });

  it("survives an unquoted > inside an attribute", () => {
    const blocks = parseRichHtml('<p><img src="/a.png" alt="a > b" />text</p>');
    expect(blocks[0]).toEqual({ type: "image", src: "/a.png", alt: "a > b" });
    expect(blocks[1].type).toBe("paragraph");
  });

  it("collapses whitespace and drops empty paragraphs", () => {
    const blocks = parseRichHtml("<p>  </p>\n<p>  kept\n  words </p>");
    expect(blocks).toEqual([{ type: "paragraph", spans: [{ text: "kept words" }] }]);
  });

  it("round-trips the editor's own HTML output", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Why GEO" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See " },
            {
              type: "text",
              text: "our pillar",
              marks: [{ type: "link", attrs: { href: "https://altorank.co/geo" } }],
            },
            { type: "text", text: " for the long version." },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] },
          ],
        },
      ],
    });
    const blocks = parseRichHtml(html);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "listItem"]);
    if (blocks[1].type !== "paragraph") throw new Error("expected paragraph");
    expect(blocks[1].spans.find((s) => s.href)?.href).toBe("https://altorank.co/geo");
  });

  it("hasReadableContent is false for markup with no words", () => {
    expect(hasReadableContent(parseRichHtml(""))).toBe(false);
    expect(hasReadableContent(parseRichHtml("<p></p><p>   </p>"))).toBe(false);
    expect(hasReadableContent(parseRichHtml("<p>a</p>"))).toBe(true);
  });
});

describe("decodeEntities", () => {
  it("leaves an unknown entity alone rather than eating it", () => {
    expect(decodeEntities("&nosuchthing; &amp;")).toBe("&nosuchthing; &");
  });
});
