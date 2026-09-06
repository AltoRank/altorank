import { describe, it, expect } from "vitest";
import { pageLinksFromIndex, readSource, type Fetcher } from "../detect";

// Detection turns a source into page URLs. Network and database are out of
// reach here, so the fetcher is a map of URL to body, and what is pinned is
// the mapping: which URLs come out of a sitemap, an index, a blog page, and
// what a source that cannot be read says about itself.

const sitemap = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.co/</loc></url>
  <url><loc>https://x.co/pricing</loc></url>
  <url><loc>https://x.co/blog/</loc></url>
  <url><loc>https://x.co/blog/best-crm-software</loc></url>
  <url><loc>https://x.co/blog/email-deliverability-guide</loc></url>
  <url><loc>https://x.co/blog/tag/crm</loc></url>
</urlset>`;

const index = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://x.co/sitemap-posts.xml</loc></sitemap>
  <sitemap><loc>https://x.co/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`;

const pagesSitemap = `<urlset><url><loc>https://x.co/about</loc></url><url><loc>https://x.co/insights/why-we-built-this</loc></url></urlset>`;

const blogHtml = `<html><body>
  <nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/blog/">Blog</a></nav>
  <main>
    <a href="/blog/best-crm-software">Best CRM</a>
    <a href="https://x.co/blog/email-deliverability-guide#top">Deliverability</a>
    <a href="/blog/page/2">Next</a>
    <a href="/blog/tag/crm">crm</a>
    <a href="https://other.com/blog/thing">elsewhere</a>
    <a href="/blog/best-crm-software?utm=x">Best CRM again</a>
  </main>
</body></html>`;

function fetcher(bodies: Record<string, string>): Fetcher {
  return async (url) => bodies[url] ?? null;
}

describe("readSource: sitemap", () => {
  it("keeps the article-looking URLs and drops the index, tag and marketing pages", async () => {
    const read = await readSource(
      { kind: "sitemap", url: "https://x.co/sitemap.xml" },
      fetcher({ "https://x.co/sitemap.xml": sitemap }),
    );
    expect(read.error).toBeNull();
    expect(read.urls.sort()).toEqual([
      "https://x.co/blog/best-crm-software",
      "https://x.co/blog/email-deliverability-guide",
    ]);
  });

  it("follows a sitemap index one level", async () => {
    const read = await readSource(
      { kind: "sitemap", url: "https://x.co/sitemap.xml" },
      fetcher({
        "https://x.co/sitemap.xml": index,
        "https://x.co/sitemap-posts.xml": sitemap,
        "https://x.co/sitemap-pages.xml": pagesSitemap,
      }),
    );
    expect(read.urls.sort()).toEqual([
      "https://x.co/blog/best-crm-software",
      "https://x.co/blog/email-deliverability-guide",
      "https://x.co/insights/why-we-built-this",
    ]);
  });

  it("falls back to the sitemap robots.txt declares when the URL is not one", async () => {
    const read = await readSource(
      { kind: "sitemap", url: "https://x.co/sitemap.xml" },
      fetcher({
        "https://x.co/sitemap.xml": "<html>Not found</html>",
        "https://x.co/robots.txt": "User-agent: *\nSitemap: https://x.co/wp-sitemap.xml\n",
        "https://x.co/wp-sitemap.xml": sitemap,
      }),
    );
    expect(read.error).toBeNull();
    expect(read.urls).toHaveLength(2);
  });

  it("reports an unreadable sitemap as an error, with no URLs and no count", async () => {
    const read = await readSource({ kind: "sitemap", url: "https://x.co/sitemap.xml" }, fetcher({}));
    expect(read.urls).toEqual([]);
    expect(read.error).toMatch(/could not fetch/i);
  });

  it("says when the address answered but was not a sitemap", async () => {
    const read = await readSource(
      { kind: "sitemap", url: "https://x.co/sitemap.xml" },
      fetcher({ "https://x.co/sitemap.xml": "<html>hi</html>", "https://x.co/robots.txt": "User-agent: *" }),
    );
    expect(read.error).toMatch(/not a sitemap/i);
  });
});

describe("readSource: blog root", () => {
  it("keeps same-origin pages under the index, without chrome, pagination, tags or query strings", async () => {
    const read = await readSource(
      { kind: "blog_root", url: "https://x.co/blog/" },
      fetcher({ "https://x.co/blog/": blogHtml }),
    );
    expect(read.error).toBeNull();
    expect(read.urls.sort()).toEqual([
      "https://x.co/blog/best-crm-software",
      "https://x.co/blog/email-deliverability-guide",
    ]);
  });

  it("says so when the index answered but listed nothing, and still counts zero", async () => {
    const read = await readSource(
      { kind: "blog_root", url: "https://x.co/blog/" },
      fetcher({ "https://x.co/blog/": "<html><body><div id=app></div></body></html>" }),
    );
    expect(read.urls).toEqual([]);
    expect(read.error).toBeNull();
    expect(read.note).toMatch(/JavaScript/);
  });

  it("reports a blog index it could not fetch", async () => {
    const read = await readSource({ kind: "blog_root", url: "https://x.co/blog/" }, fetcher({}));
    expect(read.urls).toEqual([]);
    expect(read.error).toMatch(/could not fetch/i);
  });
});

describe("readSource: single URL", () => {
  it("is the page itself, fragment dropped", async () => {
    const read = await readSource({ kind: "manual_url", url: "https://x.co/pricing#plans" }, fetcher({}));
    expect(read).toEqual({ urls: ["https://x.co/pricing"], error: null });
  });

  it("rejects something that is not a URL", async () => {
    const read = await readSource({ kind: "manual_url", url: "not a url" }, fetcher({}));
    expect(read.urls).toEqual([]);
    expect(read.error).toMatch(/not a valid url/i);
  });
});

describe("pageLinksFromIndex", () => {
  it("returns nothing for an index whose URL cannot be parsed", () => {
    expect(pageLinksFromIndex(blogHtml, "nope")).toEqual([]);
  });

  it("with an index at the site root, keeps every same-origin page but the root", () => {
    const out = pageLinksFromIndex(blogHtml, "https://x.co/");
    expect(out).toContain("https://x.co/pricing");
    expect(out).toContain("https://x.co/blog/");
    expect(out).not.toContain("https://x.co/");
    expect(out.some((u) => u.includes("other.com"))).toBe(false);
  });
});
