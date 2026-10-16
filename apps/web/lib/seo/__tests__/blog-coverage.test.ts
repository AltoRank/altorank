import { writeFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { FIXTURE_SITES, serveFixture, type FixtureSite } from "./fixtures/blog-sites";
import { prioritise } from "../site-crawl";
import { readSiteUrls, withSiteReads } from "../site-urls";
import { discoverSite } from "@/lib/onboarding/site-discovery";
import { readSource, sitePostsWithoutSources } from "@/lib/linking/detect";
import { ONBOARDING_CRAWL } from "@/lib/onboarding/site-assessment";

// What a first look sees of a site's existing blog, measured end to end on
// fixture sites: the wizard's discovery (voice examples, sitemap and blog
// root), the page crawl's choice of what to read, and the link pool. Every
// reader runs, the way one onboarding run runs them, and every request is
// counted. Numbers from origin/main before this change are in the PR.

export interface Coverage {
  site: string;
  posts: number;
  /** Posts the sitemap (or fallback) walk listed. */
  listed: number;
  /** Posts among the pages the crawl reads (its cap). */
  read: number;
  /** Of the ten newest posts, how many the crawl reads. */
  newestRead: number;
  /** Posts in the link pool. */
  linkPool: number;
  /** Voice examples that are posts, and how many of them are among the ten newest. */
  voice: number;
  voiceNewest: number;
  requests: number;
}

export async function measure(site: FixtureSite): Promise<Coverage> {
  const served = serveFixture(site);
  const original = globalThis.fetch;
  globalThis.fetch = served.fetch;
  try {
    return await withSiteReads(async () => {
      const truth = new Set(site.posts);
      const newest = new Set(site.posts.slice(0, 10));
      const discovery = await discoverSite(site.domain);
      // The page crawl (syncSitePages) and the ranked-keyword filter
      // (ownSitemapPaths) each read the list again.
      const listedRead = await readSiteUrls(site.domain);
      await readSiteUrls(site.domain, { fallback: false });
      const crawl = prioritise(listedRead.urls, ONBOARDING_CRAWL.maxPages);
      const pool = new Set<string>();
      for (const source of [
        ...(discovery.sitemapUrl ? [{ kind: "sitemap" as const, url: discovery.sitemapUrl }] : []),
        ...(discovery.blogRootUrl ? [{ kind: "blog_root" as const, url: discovery.blogRootUrl }] : []),
      ]) {
        for (const u of (await readSource(source)).urls) pool.add(u);
      }
      // detectLinks' own fallback when no source listed anything.
      if (!pool.size) for (const u of await sitePostsWithoutSources(site.domain)) pool.add(u);
      return {
        site: site.name,
        posts: site.posts.length,
        listed: listedRead.urls.filter((u) => truth.has(u.url)).length,
        read: crawl.filter((u) => truth.has(u)).length,
        newestRead: crawl.filter((u) => newest.has(u)).length,
        linkPool: [...pool].filter((u) => truth.has(u)).length,
        voice: discovery.exampleArticleUrls.filter((u) => truth.has(u)).length,
        voiceNewest: discovery.exampleArticleUrls.filter((u) => newest.has(u)).length,
        requests: served.requests.length,
      };
    });
  } finally {
    globalThis.fetch = original;
  }
}

const bySite = (name: string) => FIXTURE_SITES.find((s) => s.name.startsWith(name))!;

describe("what a first look sees of an existing blog", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("WordPress: every root-level post is listed, the crawl reads the newest, the pool keeps them all", async () => {
    const c = await measure(bySite("WordPress"));
    expect(c.listed).toBe(120);
    expect(c.read).toBe(ONBOARDING_CRAWL.maxPages);
    expect(c.newestRead).toBe(10);
    expect(c.linkPool).toBe(120);
    expect(c.voice).toBe(3);
    expect(c.voiceNewest).toBe(3);
  });

  it("Shopify: the blog sitemap is read before 3,000 products fill the list", async () => {
    const c = await measure(bySite("Shopify"));
    expect(c.listed).toBe(30);
    expect(c.read).toBe(30);
    expect(c.newestRead).toBe(10);
    expect(c.linkPool).toBe(30);
    expect(c.voiceNewest).toBe(3);
  });

  it("no sitemap: the blog index and its next pages stand in", async () => {
    const c = await measure(bySite("Hand-built"));
    expect(c.listed).toBe(25);
    expect(c.linkPool).toBe(25);
    expect(c.voice).toBe(3);
  });

  it("no sitemap: the feed the homepage declares stands in, newest first", async () => {
    const c = await measure(bySite("No sitemap, RSS"));
    expect(c.listed).toBe(12);
    expect(c.newestRead).toBe(10);
    expect(c.linkPool).toBe(12);
    expect(c.voiceNewest).toBe(3);
  });

  it("/magazine/: posts are recognised, read newest first, and pooled", async () => {
    const c = await measure(bySite("Subfolder"));
    expect(c.listed).toBe(50);
    expect(c.read).toBe(ONBOARDING_CRAWL.maxPages);
    expect(c.newestRead).toBe(10);
    expect(c.linkPool).toBe(50);
    expect(c.voiceNewest).toBe(3);
  });

  it("each site file is fetched once, however many readers ask", async () => {
    for (const site of FIXTURE_SITES) {
      const served = serveFixture(site);
      globalThis.fetch = served.fetch;
      await withSiteReads(async () => {
        await discoverSite(site.domain);
        await readSiteUrls(site.domain);
        await readSiteUrls(site.domain, { fallback: false });
      });
      const repeats = served.requests.filter((u, i) => served.requests.indexOf(u) !== i);
      expect(repeats, site.name).toEqual([]);
    }
  });

  it("prints the table the PR quotes", async () => {
    const rows = [];
    for (const site of FIXTURE_SITES) rows.push(await measure(site));
    // COVERAGE_OUT=/path/to/file.json writes the rows for the PR's table.
    if (process.env.COVERAGE_OUT) writeFileSync(process.env.COVERAGE_OUT, JSON.stringify(rows, null, 2));
    expect(rows).toHaveLength(FIXTURE_SITES.length);
  });
});
