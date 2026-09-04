import { describe, it, expect } from "vitest";
import { sitemapsFromRobots, looksLikeSitemap, articleUrlsFromSitemap } from "../site-discovery";

describe("site discovery parsing", () => {
  it("reads Sitemap lines from robots.txt, relative or absolute", () => {
    const robots = "User-agent: *\nDisallow: /admin\nSitemap: https://a.com/sitemap-index.xml\nsitemap: /other.xml\n";
    expect(sitemapsFromRobots(robots, "https://a.com")).toEqual(["https://a.com/sitemap-index.xml", "https://a.com/other.xml"]);
  });
  it("recognises a sitemap by its root element, not its extension", () => {
    expect(looksLikeSitemap('<?xml version="1.0"?><urlset xmlns="x"><url><loc>a</loc></url></urlset>')).toBe(true);
    expect(looksLikeSitemap("<sitemapindex><sitemap><loc>x</loc></sitemap></sitemapindex>")).toBe(true);
    expect(looksLikeSitemap("<!doctype html><html><body>404</body></html>")).toBe(false);
  });
  it("picks article-looking URLs and ignores taxonomy and files", () => {
    const body = [
      "<urlset>",
      "<url><loc>https://a.com/</loc></url>",
      "<url><loc>https://a.com/blog/</loc></url>",
      "<url><loc>https://a.com/blog/how-to-rank-in-2026</loc></url>",
      "<url><loc>https://a.com/blog/tag/seo/</loc></url>",
      "<url><loc>https://a.com/pricing</loc></url>",
      "<url><loc>https://a.com/2026/09/a-dated-post</loc></url>",
      "<url><loc>https://a.com/sitemap-posts.xml</loc></url>",
      "</urlset>",
    ].join("");
    expect(articleUrlsFromSitemap(body)).toEqual(["https://a.com/blog/how-to-rank-in-2026", "https://a.com/2026/09/a-dated-post"]);
  });
});
