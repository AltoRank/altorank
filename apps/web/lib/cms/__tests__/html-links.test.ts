import { describe, it, expect } from "vitest";
import { tiptapToHtml } from "../html";

const doc = (marks: Record<string, unknown>) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "source", marks: [{ type: "link", attrs: marks }] }] }],
});

describe("tiptapToHtml — link attributes", () => {
  it("publishes an external citation with the target and rel the generator stored", () => {
    // Before: `href` only, so every citation went out followed and same-tab.
    expect(tiptapToHtml(doc({ href: "https://example.org/study", target: "_blank", rel: "noopener noreferrer nofollow" }))).toBe(
      '<p><a href="https://example.org/study" target="_blank" rel="noopener noreferrer nofollow">source</a></p>',
    );
  });

  it("publishes an internal link with neither, whether stored as null or omitted", () => {
    expect(tiptapToHtml(doc({ href: "https://www.example.com/blog/x", target: null, rel: null }))).toBe(
      '<p><a href="https://www.example.com/blog/x">source</a></p>',
    );
    expect(tiptapToHtml(doc({ href: "https://www.example.com/blog/x" }))).toBe('<p><a href="https://www.example.com/blog/x">source</a></p>');
  });

  it("never nofollows a relative path, even one the editor stamped its defaults on", () => {
    expect(tiptapToHtml(doc({ href: "/blog/x", target: "_blank", rel: "noopener noreferrer nofollow" }))).toBe(
      '<p><a href="/blog/x">source</a></p>',
    );
    expect(tiptapToHtml(doc({ href: "#faq", rel: "nofollow" }))).toBe('<p><a href="#faq">source</a></p>');
  });

  it("escapes the attribute values", () => {
    expect(tiptapToHtml(doc({ href: 'https://e.org/?a="1"', target: '_blank"onclick="x' }))).toBe(
      '<p><a href="https://e.org/?a=&quot;1&quot;" target="_blank&quot;onclick=&quot;x">source</a></p>',
    );
  });
});
