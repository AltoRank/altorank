import { describe, expect, it } from "vitest";
import { renderArticleMarkdown } from "../export";

const article = {
  title: 'Warehouse "orchestration" explained',
  slug: "what-is-warehouse-orchestration",
  metaDescription: "What it is and why it matters.",
  keyword: "warehouse orchestration",
  html: "<h2>Definition</h2><p>It is <strong>software</strong> that sequences work. See <a href=\"/pricing\">pricing</a>.</p>",
  publishedAt: "2026-09-02T10:00:00.000Z",
};

describe("renderArticleMarkdown", () => {
  it("renders front matter the git adapter would commit, then the body", () => {
    const md = renderArticleMarkdown(article, "https://www.lully.ai");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain('title: "Warehouse \\"orchestration\\" explained"');
    expect(md).toContain('description: "What it is and why it matters."');
    expect(md).toContain('slug: "what-is-warehouse-orchestration"');
    expect(md).toContain('publishDate: "2026-09-02"');
    expect(md).toContain('keyword: "warehouse orchestration"');
    // Front matter closes before the body starts.
    const close = md.indexOf("\n---\n", 4);
    expect(close).toBeGreaterThan(0);
    expect(md.slice(close)).toContain("Definition");
    expect(md.slice(close)).toContain("**software**");
  });

  it("resolves relative links against the site, so a paste elsewhere still points home", () => {
    const md = renderArticleMarkdown(article, "https://www.lully.ai");
    expect(md).toContain("https://www.lully.ai/pricing");
  });

  it("omits fields the article does not have rather than writing empty strings", () => {
    const md = renderArticleMarkdown(
      { title: "T", slug: "t", html: "<p>x</p>", metaDescription: null, keyword: null, featuredImageUrl: null },
      "https://example.com",
    );
    expect(md).not.toContain("description:");
    expect(md).not.toContain("keyword:");
    expect(md).not.toContain("ogImage:");
    // No publishedAt: today, as a date, never a blank.
    expect(md).toMatch(/publishDate: "\d{4}-\d{2}-\d{2}"/);
  });
});
