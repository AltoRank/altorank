import { describe, it, expect } from "vitest";
import {
  childRank,
  feedEntries,
  feedLinksIn,
  getSiteFile,
  isSitemapIndex,
  looksLikePost,
  nextPageOf,
  prioritiseSiteUrls,
  readSiteUrls,
  siteReadRequests,
  sitemapEntries,
  withSiteReads,
  type SiteGet,
} from "../site-urls";
import { intentWords, wordsCover } from "@/lib/keyword-research/intent";
import { slugWords } from "../recommendations";

describe("looksLikePost", () => {
  it.each([
    ["https://x.co/blog/how-to-rank", true],
    ["https://x.co/blogs/news/care-guide", true],
    ["https://x.co/magazine/story-1", true],
    ["https://x.co/journal/entry", true],
    ["https://x.co/learn/what-is-geo", true],
    ["https://x.co/it/articoli/come-fare", true],
    ["https://x.co/2026/09/a-dated-post/", true],
    ["https://x.co/how-to-choose-a-crm-in-2026/", true],
  ])("%s is a post", (url, want) => expect(looksLikePost(url)).toBe(want));

  it.each([
    "https://x.co/",
    "https://x.co/blog/",
    "https://x.co/blogs/news",
    "https://x.co/blogs/my-handle",
    "https://x.co/blog/de",
    "https://x.co/blog/page/2/",
    "https://x.co/category/news/",
    "https://x.co/tag/seo/",
    "https://x.co/pricing",
    "https://x.co/web-design-agency",
    "https://x.co/privacy-policy-and-cookie-terms/",
    "https://x.co/wp-content/uploads/a-b-c-d.jpg",
  ])("%s is not", (url) => expect(looksLikePost(url)).toBe(false));

  it("trusts a post list for a root-level slug, but not for the pages every site has", () => {
    expect(looksLikePost("https://x.co/short-post/", { fromPostList: true })).toBe(true);
    expect(looksLikePost("https://x.co/pricing/", { fromPostList: true })).toBe(false);
  });
});

describe("parsing", () => {
  it("reads lastmod beside each loc, and tells an index from a sitemap", () => {
    const xml = `<urlset><url><loc>https://x.co/a</loc><lastmod>2026-09-01</lastmod></url><url><loc>https://x.co/b&amp;c</loc></url></urlset>`;
    expect(sitemapEntries(xml)).toEqual([
      { loc: "https://x.co/a", lastmod: "2026-09-01T00:00:00.000Z" },
      { loc: "https://x.co/b&c", lastmod: null },
    ]);
    expect(isSitemapIndex(xml)).toBe(false);
    expect(isSitemapIndex(`<sitemapindex><sitemap><loc>https://x.co/p.xml</loc></sitemap></sitemapindex>`)).toBe(true);
  });

  it("ranks post sitemaps first and products, taxonomy and media last", () => {
    expect(childRank("https://x.co/post-sitemap.xml")).toBe(0);
    expect(childRank("https://x.co/wp-sitemap-posts-post-1.xml")).toBe(0);
    expect(childRank("https://x.co/sitemap_blogs_1.xml")).toBe(0);
    expect(childRank("https://x.co/page-sitemap.xml")).toBe(1);
    expect(childRank("https://x.co/sitemap_products_1.xml?from=1&to=9")).toBe(3);
    expect(childRank("https://x.co/category-sitemap.xml")).toBe(3);
    expect(childRank("https://x.co/wp-sitemap-taxonomies-post_tag-1.xml")).toBe(3);
  });

  it("reads RSS and Atom entries with their dates", () => {
    const rss = `<rss><channel><item><link>https://x.co/p1</link><pubDate>Tue, 30 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const atom = `<feed><entry><link rel="alternate" href="https://x.co/p2"/><published>2026-09-29T00:00:00Z</published></entry></feed>`;
    expect(feedEntries(rss)).toEqual([{ loc: "https://x.co/p1", lastmod: "2026-09-30T10:00:00.000Z" }]);
    expect(feedEntries(atom)).toEqual([{ loc: "https://x.co/p2", lastmod: "2026-09-29T00:00:00.000Z" }]);
  });

  it("finds the post feed a page declares, not its comment feed", () => {
    const head = `<link rel="alternate" type="application/rss+xml" href="/feed/"><link rel="alternate" type="application/rss+xml" href="/comments/feed/">`;
    expect(feedLinksIn(head, "https://x.co")).toEqual(["https://x.co/feed/"]);
  });

  it("follows rel=next, or a /page/N+1 link", () => {
    expect(nextPageOf(`<link rel="next" href="/blog/page/2/">`, "https://x.co/blog/")).toBe("https://x.co/blog/page/2/");
    expect(nextPageOf(`<a href="/blog/page/3/">3</a>`, "https://x.co/blog/page/2/")).toBe("https://x.co/blog/page/3/");
    expect(nextPageOf(`<a href="/about">about</a>`, "https://x.co/blog/")).toBeNull();
  });
});

describe("prioritiseSiteUrls", () => {
  it("puts posts first, newest first, undated posts after dated ones, then the rest in order", () => {
    const out = prioritiseSiteUrls([
      { url: "https://x.co/pricing", lastmod: "2026-10-01T00:00:00.000Z", fromPostList: false },
      { url: "https://x.co/blog/old", lastmod: "2025-01-01T00:00:00.000Z", fromPostList: false },
      { url: "https://x.co/blog/undated", lastmod: null, fromPostList: false },
      { url: "https://x.co/blog/new", lastmod: "2026-09-01T00:00:00.000Z", fromPostList: false },
      { url: "https://x.co/about", lastmod: null, fromPostList: false },
    ], 4).map((e) => e.url);
    expect(out).toEqual(["https://x.co/blog/new", "https://x.co/blog/old", "https://x.co/blog/undated", "https://x.co/pricing"]);
  });
});

describe("readSiteUrls", () => {
  const getFrom = (files: Record<string, string>, asked: string[] = []): SiteGet => async (url) => {
    asked.push(url);
    const body = files[url] ?? null;
    return { status: body === null ? 404 : 200, body, finalUrl: url };
  };

  it("probes the conventional sitemap paths only until one answers", async () => {
    const asked: string[] = [];
    const read = await readSiteUrls("x.co", {
      get: getFrom({ "https://x.co/sitemap.xml": `<urlset><url><loc>https://x.co/blog/a</loc></url></urlset>` }, asked),
    });
    expect(read.source).toBe("sitemap");
    expect(read.urls.map((u) => u.url)).toEqual(["https://x.co/blog/a"]);
    expect(asked).toEqual(["https://x.co/robots.txt", "https://x.co/sitemap.xml"]);
  });

  it("follows an index of indexes", async () => {
    const read = await readSiteUrls("x.co", {
      get: getFrom({
        "https://x.co/robots.txt": "Sitemap: https://x.co/root.xml",
        "https://x.co/root.xml": `<sitemapindex><sitemap><loc>https://x.co/mid.xml</loc></sitemap></sitemapindex>`,
        "https://x.co/mid.xml": `<sitemapindex><sitemap><loc>https://x.co/post-sitemap.xml</loc></sitemap></sitemapindex>`,
        "https://x.co/post-sitemap.xml": `<urlset><url><loc>https://x.co/hello-world</loc></url></urlset>`,
      }),
    });
    expect(read.urls).toEqual([{ url: "https://x.co/hello-world", lastmod: null, fromPostList: true }]);
  });

  it("stops at the deadline and says so", async () => {
    const read = await readSiteUrls("x.co", { deadline: Date.now() - 1, get: getFrom({}) });
    expect(read.urls).toEqual([]);
    expect(read.truncated).toBe(true);
  });
});

describe("withSiteReads", () => {
  const counting = () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("<urlset></urlset>", { status: 200 });
    }) as typeof fetch;
    return { calls: () => calls, restore: () => { globalThis.fetch = original; } };
  };

  it("fetches a file once for every reader in the scope, even concurrent ones", async () => {
    const f = counting();
    try {
      await withSiteReads(async () => {
        await Promise.all([getSiteFile("https://x.co/sitemap.xml"), getSiteFile("https://x.co/sitemap.xml")]);
        await getSiteFile("https://x.co/sitemap.xml");
        expect(siteReadRequests()).toBe(1);
      });
      expect(f.calls()).toBe(1);
    } finally { f.restore(); }
  });

  it("caches nothing outside a scope", async () => {
    const f = counting();
    try {
      await getSiteFile("https://x.co/sitemap.xml");
      await getSiteFile("https://x.co/sitemap.xml");
      expect(f.calls()).toBe(2);
      expect(siteReadRequests()).toBeNull();
    } finally { f.restore(); }
  });

  it("lets a later reader retry a file that never answered", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("socket hang up");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      await withSiteReads(async () => {
        expect((await getSiteFile("https://x.co/robots.txt")).status).toBe(0);
        expect((await getSiteFile("https://x.co/robots.txt")).body).toBe("ok");
      });
    } finally { globalThis.fetch = original; }
  });
});

describe("a page already targets a search", () => {
  const covers = (term: string, url: string) => wordsCover(intentWords(term, "en"), intentWords(slugWords(url), "en"));

  it("when every word of the search is in the slug and makes up most of it", () => {
    expect(covers("gym management software", "https://x.co/blog/how-to-choose-gym-management-software/")).toBe(true);
    expect(covers("personal trainer app", "https://x.co/blog/best-personal-trainer-apps-2026")).toBe(true);
  });

  it("not when the search is broader than the page or shares a word", () => {
    expect(covers("gym software", "https://x.co/blog/how-to-choose-gym-management-software/")).toBe(false);
    expect(covers("crm software", "https://x.co/blog/gym-management-software")).toBe(false);
  });

  it("never on one word", () => {
    expect(covers("software", "https://x.co/software")).toBe(false);
  });
});
