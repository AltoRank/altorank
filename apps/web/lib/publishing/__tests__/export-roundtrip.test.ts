import { describe, it, expect } from "vitest";
import { renderArticleMarkdown } from "../export";
import { htmlToMarkdown } from "@/lib/audit/markdown";
import { renderPost } from "@/lib/cms/git";

// The editor's Export menu renders Markdown on the server through
// renderArticleMarkdown. This pins two things: that what the editor holds
// (Tiptap's HTML: headings, lists, links, images, tables) survives the
// conversion, and that it is the same converter the git adapter commits with,
// so "Export as Markdown" and "publish to a repository" cannot drift apart.

const html = [
  "<h2>What it is</h2>",
  '<p>It is <strong>software</strong> that <em>sequences</em> work. See <a href="/pricing">pricing</a> and <a href="https://example.org/ref">a source</a>.</p>',
  '<img src="https://cdn.example.com/hero.webp" alt="A warehouse floor">',
  "<ul><li>First point</li><li>Second point</li></ul>",
  "<h3>Steps</h3>",
  "<ol><li>Plan</li><li>Ship</li></ol>",
  "<table><tr><th>Tool</th><th>Price</th></tr><tr><td>A</td><td>Free</td></tr></table>",
].join("");

describe("Markdown export round trip", () => {
  it("keeps headings, emphasis, links, image alt, lists and tables", () => {
    const md = renderArticleMarkdown(
      { title: "T", slug: "t", html, metaDescription: "D", keyword: "k", featuredImageUrl: "https://cdn/x.webp" },
      "https://www.site.test",
    );
    const body = md.slice(md.indexOf("\n---\n", 4));
    expect(body).toContain("## What it is");
    expect(body).toContain("**software**");
    expect(body).toContain("*sequences*");
    expect(body).toContain("[pricing](https://www.site.test/pricing)");
    expect(body).toContain("[a source](https://example.org/ref)");
    expect(body).toContain("![A warehouse floor]");
    expect(body).toContain("- First point");
    expect(body).toContain("### Steps");
    // The shared converter flattens ordered lists to bullets; that is its
    // behaviour, not this export's, so pin the item rather than the marker.
    expect(body).toMatch(/[-\d.]+ Plan/);
    expect(body).toContain("| Tool | Price |");
    expect(md).toContain('ogImage: "https://cdn/x.webp"');
  });

  it("is the converter the git adapter commits with", () => {
    const fromExport = renderArticleMarkdown(
      { title: "T", slug: "t", html, metaDescription: "D", publishedAt: "2026-09-04T00:00:00.000Z" },
      "https://www.site.test",
    );
    const fromGit = renderPost(
      { title: "T", slug: "t", html, metaDescription: "D", publishedAt: "2026-09-04T00:00:00.000Z" } as never,
      { contentPath: "content", publicBaseUrl: "https://www.site.test" },
    );
    const body = (s: string) => s.slice(s.indexOf("\n---\n", 4)).trim();
    expect(body(fromExport)).toBe(body(fromGit.contents));
    // And both are the raw converter's output, no second pass in between.
    expect(body(fromExport)).toContain(htmlToMarkdown(html, "https://www.site.test").markdown.trim());
  });
});
