import { describe, it, expect } from "vitest";
import { extractArticleMeta, stripAiTypography, stripDeadLinks } from "../utils";

// claude-haiku-4-5 wrapped a whole article in ```html on 2026-08-30 and the
// fence reached the stored HTML, so the page would have opened with a literal
// ```html. Cheap models do this; the parser has to survive it.
describe("extractArticleMeta — code fences", () => {
  const body = "<h1>Title</h1>\n<p>Body copy.</p>";

  it("strips a ```html fence wrapping the whole response", () => {
    const r = extractArticleMeta("```html\n" + body + "\n```");
    expect(r.cleanHtml.startsWith("```")).toBe(false);
    expect(r.title).toBe("Title");
  });

  it("strips a bare ``` fence", () => {
    expect(extractArticleMeta("```\n" + body + "\n```").cleanHtml).not.toContain("```");
  });

  it("leaves unfenced HTML untouched", () => {
    expect(extractArticleMeta(body).title).toBe("Title");
  });

  it("does not strip a fence that is only inside the body", () => {
    // A code sample in the article is content, not a wrapper.
    const withSample = "<h1>T</h1><pre>```bash\nnpm i\n```</pre>";
    expect(extractArticleMeta(withSample).cleanHtml).toContain("```bash");
  });
});

describe("extractArticleMeta — dead links", () => {
  it("unwraps href=\"#\" but keeps the words", () => {
    // A real run emitted eight of these despite the brief forbidding them.
    const r = extractArticleMeta('<h1>T</h1><p>See <a href="#">our guide</a> here.</p>');
    expect(r.cleanHtml).not.toContain('href="#"');
    expect(r.cleanHtml).toContain("our guide");
  });

  it("leaves real links alone", () => {
    const r = extractArticleMeta('<h1>T</h1><p><a href="https://example.com">x</a></p>');
    expect(r.cleanHtml).toContain("https://example.com");
  });

  it("leaves internal-link placeholders alone for the resolver", () => {
    const r = extractArticleMeta('<h1>T</h1><p><a href="{{internal-link:seo}}">x</a></p>');
    expect(r.cleanHtml).toContain("{{internal-link:seo}}");
  });
});

describe("stripDeadLinks — placeholders", () => {
  const html = '<p><a href="{{internal-link:seo}}">seo</a> <a href="#">x</a> <a href="/y">y</a></p>';

  it("keeps placeholders by default, so the resolver gets its turn", () => {
    expect(stripDeadLinks(html)).toBe('<p><a href="{{internal-link:seo}}">seo</a> x <a href="/y">y</a></p>');
  });

  it("unwraps them when asked, which is what the resolver does with its leftovers", () => {
    expect(stripDeadLinks(html, { placeholders: true })).toBe('<p>seo x <a href="/y">y</a></p>');
  });
});

describe("stripAiTypography", () => {
  it("turns a clause em dash into a comma", () => {
    expect(stripAiTypography("<p>Free tiers exist — most cap volume.</p>")).toBe(
      "<p>Free tiers exist, most cap volume.</p>",
    );
  });

  it("turns a label em dash after bold into a colon", () => {
    expect(
      stripAiTypography("<li><strong>Setmore</strong> — free for four staff</li>"),
    ).toBe("<li><strong>Setmore</strong>: free for four staff</li>");
  });

  it("keeps numeric ranges as an en dash", () => {
    expect(stripAiTypography("<p>Open 9 — 17 on weekdays.</p>")).toBe(
      "<p>Open 9–17 on weekdays.</p>",
    );
  });

  it("collapses double hyphens used as a dash", () => {
    expect(stripAiTypography("<p>fast -- and free</p>")).toBe("<p>fast, and free</p>");
  });

  it("leaves hyphens and en dashes alone", () => {
    const s = "<p>a well-known, real–world example</p>";
    expect(stripAiTypography(s)).toBe(s);
  });
});
