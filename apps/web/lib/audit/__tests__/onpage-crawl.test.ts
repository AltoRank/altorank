import { describe, it, expect, vi, beforeEach } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/seo/client", () => ({ post, hasDataForSEOCredentials: () => true }));

const { postCrawl, fetchSummary, fetchBrokenLinks, fetchOrphanPages } = await import("../onpage-crawl");

const reply = (result: unknown, id = "task-1") =>
  post.mockResolvedValue({ tasks: [{ id, result: [result] }] });

beforeEach(() => post.mockReset());

describe("postCrawl", () => {
  it("does not pay for resources or a browser", async () => {
    // Images and stylesheets are not pages, and rendering multiplies the
    // price for a signal none of these reports read.
    reply(null);
    const h = await postCrawl("x.co", { maxPages: 50 });
    expect(h.id).toBe("task-1");
    expect(post.mock.calls[0][1][0]).toMatchObject({
      target: "x.co",
      max_crawl_pages: 50,
      load_resources: false,
      enable_javascript: false,
    });
  });

  it("throws rather than returning a handle with no id", async () => {
    post.mockResolvedValue({ tasks: [{}] });
    await expect(postCrawl("x.co")).rejects.toThrow(/no task id/);
  });
});

describe("fetchSummary", () => {
  // Shapes taken from a real 50-page crawl of fitsuite.co on 2026-09-04.
  const real = {
    crawl_progress: "finished",
    crawl_status: { pages_crawled: 50 },
    page_metrics: {
      onpage_score: 94.9,
      links_internal: 2667,
      links_external: 1104,
      broken_links: 9,
      duplicate_title: 2,
      duplicate_content: 2,
      non_indexable: 0,
      checks: {
        is_https: 50,
        canonical: 49,
        has_html_doctype: 49,
        seo_friendly_url: 30,
        low_content_rate: 44,
        title_too_long: 16,
        low_readability_rate: 17,
        is_broken: 1,
        no_h1_tag: 0,
        some_unknown_check: 12,
      },
    },
  };

  it("counts only the checks that mean harm, ordered worst first", async () => {
    // 50 pages reporting is_https is good news. Taken at face value the
    // true-set describes a wholly broken site.
    reply(real);
    const s = await fetchSummary({ id: "t", target: "x.co" });
    expect(s.faults).toEqual([
      { check: "low_content_rate", pages: 44 },
      { check: "low_readability_rate", pages: 17 },
      { check: "title_too_long", pages: 16 },
      { check: "is_broken", pages: 1 },
    ]);
    expect(s.faults.map((f) => f.check)).not.toContain("is_https");
    // A check with a zero count is not a finding.
    expect(s.faults.map((f) => f.check)).not.toContain("no_h1_tag");
    // And one whose polarity we do not know is left out rather than guessed.
    expect(s.faults.map((f) => f.check)).not.toContain("some_unknown_check");
  });

  it("carries the site-wide numbers our own crawl cannot compute", async () => {
    reply(real);
    const s = await fetchSummary({ id: "t", target: "x.co" });
    expect(s).toMatchObject({
      pagesCrawled: 50,
      brokenLinks: 9,
      duplicateTitle: 2,
      duplicateContent: 2,
      nonIndexable: 0,
      finished: true,
    });
  });

  it("reports an unfinished crawl as unfinished rather than empty", async () => {
    reply({ crawl_progress: "in_progress", crawl_status: { pages_crawled: 12 } });
    const s = await fetchSummary({ id: "t", target: "x.co" });
    expect(s.finished).toBe(false);
    expect(s.pagesCrawled).toBe(12);
    // Unmeasured, not zero.
    expect(s.onPageScore).toBeNull();
  });

  it("survives a task that is not ready and has no result", async () => {
    // A queued task answers with an empty result rather than an error, and
    // pollers hit this on every call until the crawl finishes.
    post.mockResolvedValue({ tasks: [{ result: null }] });
    const s = await fetchSummary({ id: "t", target: "x.co" });
    expect(s.finished).toBe(false);
    expect(s.pagesCrawled).toBe(0);
    expect(s.faults).toEqual([]);
  });

  // The `.catch(() => null)` in fetchSummary also guards an outright refusal,
  // which is not asserted here: vitest reports a rejection from a mock as a
  // test failure whether or not the code under test catches it, so the test
  // would fail on correct behaviour.
});

describe("fetchBrokenLinks", () => {
  it("drops Cloudflare's email obfuscation, which is not a broken link", async () => {
    // All nine "broken links" on fitsuite.co were this: Cloudflare rewrites
    // mailto: and resolves it in the browser, so a crawler sees a 404.
    reply({
      items: [
        { page_from: "https://x.co/about", link_to: "https://x.co/cdn-cgi/l/email-protection", text: "Email" },
        { page_from: "https://x.co/a", link_to: "https://gone.example/x", text: " the report " },
      ],
    });
    const broken = await fetchBrokenLinks({ id: "t", target: "x.co" });
    expect(broken).toEqual([
      { from: "https://x.co/a", to: "https://gone.example/x", anchor: "the report" },
    ]);
  });

  it("asks only for the broken ones", async () => {
    reply({ items: [] });
    await fetchBrokenLinks({ id: "t", target: "x.co" });
    expect(post.mock.calls[0][1][0].filters).toEqual([["is_broken", "=", true]]);
  });
});

describe("fetchOrphanPages", () => {
  it("returns the crawled pages nothing links to, ignoring trailing slashes", async () => {
    reply({
      items: [
        { link_to: "https://x.co/blog/one/" },
        { link_to: "https://x.co/blog/two" },
      ],
    });
    const orphans = await fetchOrphanPages({ id: "t", target: "x.co" }, [
      "https://x.co/blog/one",
      "https://x.co/blog/two/",
      "https://x.co/blog/hidden",
    ]);
    expect(orphans).toEqual(["https://x.co/blog/hidden"]);
  });
});
