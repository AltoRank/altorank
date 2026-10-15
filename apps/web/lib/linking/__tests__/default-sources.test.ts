import { describe, expect, it } from "vitest";
import { isDefaultSource } from "../default-sources";

describe("isDefaultSource", () => {
  const ws = { sitemap_url: "https://acme.com/sitemap.xml", blog_root_url: "https://acme.com/blog" };

  it("marks the site's own sitemap and blog root, which /linking re-creates on every render", () => {
    expect(isDefaultSource({ url: "https://acme.com/sitemap.xml" }, ws)).toBe(true);
    expect(isDefaultSource({ url: "https://acme.com/blog" }, ws)).toBe(true);
  });

  it("leaves a source added by hand removable, sitemap or not", () => {
    expect(isDefaultSource({ url: "https://acme.com/news-sitemap.xml" }, ws)).toBe(false);
    expect(isDefaultSource({ url: "https://acme.com/blog" }, null)).toBe(false);
    expect(isDefaultSource({ url: "https://acme.com/blog" }, { sitemap_url: null, blog_root_url: null })).toBe(false);
  });
});
