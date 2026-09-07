import { describe, it, expect } from "vitest";
import { parseRobots, isAllowed, loadRobots, ALLOW_EVERYTHING } from "../robots";

// The crawler visits sites that never asked for it, so the one instruction
// they can leave has to be read correctly. `agent-readiness` has a parser too,
// and it answers a different question ("may GPTBot fetch /"), which is why it
// only models root-level rules and this one does not.

const rules = (body: string, ua = "AltoRank-Auditor") => parseRobots(body, ua);

describe("parseRobots + isAllowed", () => {
  it("allows everything when the file has no rules for us", () => {
    const r = rules("User-agent: Googlebot\nDisallow: /private/\n");
    expect(isAllowed(r, "https://x.co/private/thing")).toBe(true);
  });

  it("applies the wildcard group when no group names us", () => {
    const r = rules("User-agent: *\nDisallow: /admin/\n");
    expect(isAllowed(r, "https://x.co/admin/login")).toBe(false);
    expect(isAllowed(r, "https://x.co/blog/post")).toBe(true);
  });

  it("lets a group naming us override the wildcard group entirely", () => {
    const r = rules("User-agent: *\nDisallow: /\n\nUser-agent: AltoRank-Auditor\nAllow: /\n");
    expect(isAllowed(r, "https://x.co/anything")).toBe(true);
  });

  it("shares one group's rules across consecutive User-agent lines", () => {
    const r = rules("User-agent: Bingbot\nUser-agent: AltoRank-Auditor\nDisallow: /wp-admin/\n");
    expect(isAllowed(r, "https://x.co/wp-admin/")).toBe(false);
  });

  it("matches * inside a pattern", () => {
    const r = rules("User-agent: *\nDisallow: /*?replytocom\n");
    expect(isAllowed(r, "https://x.co/post/one?replytocom=4")).toBe(false);
    expect(isAllowed(r, "https://x.co/post/one")).toBe(true);
  });

  it("anchors a pattern ending in $", () => {
    const r = rules("User-agent: *\nDisallow: /*.pdf$\n");
    expect(isAllowed(r, "https://x.co/files/a.pdf")).toBe(false);
    expect(isAllowed(r, "https://x.co/files/a.pdf.html")).toBe(true);
  });

  /** The RFC's tie-break: the longest matching pattern decides. */
  it("lets the more specific Allow carve an exception out of a Disallow", () => {
    const r = rules("User-agent: *\nDisallow: /blog/\nAllow: /blog/public/\n");
    expect(isAllowed(r, "https://x.co/blog/draft")).toBe(false);
    expect(isAllowed(r, "https://x.co/blog/public/post")).toBe(true);
  });

  it("gives an exact-length tie to Allow", () => {
    const r = rules("User-agent: *\nDisallow: /a/b/\nAllow: /a/b/\n");
    expect(isAllowed(r, "https://x.co/a/b/c")).toBe(true);
  });

  it("treats an empty Disallow as no rule at all", () => {
    const r = rules("User-agent: *\nDisallow:\n");
    expect(isAllowed(r, "https://x.co/whatever")).toBe(true);
  });

  it("ignores comments and reads Sitemap and Crawl-delay", () => {
    const r = rules(
      "# hello\nSitemap: https://x.co/sitemap.xml\nUser-agent: *\nCrawl-delay: 2 # be nice\nDisallow: /x/\n",
    );
    expect(r.sitemaps).toEqual(["https://x.co/sitemap.xml"]);
    expect(r.crawlDelaySeconds).toBe(2);
    expect(isAllowed(r, "https://x.co/x/y")).toBe(false);
  });
});

describe("loadRobots", () => {
  const fetcher = (status: number, body: string | null) => async () => ({ status, body });

  it("reads the rules when the file is there", async () => {
    const r = await loadRobots("https://x.co", "AltoRank-Auditor", fetcher(200, "User-agent: *\nDisallow: /q/\n"));
    expect(r.source).toBe("fetched");
    expect(isAllowed(r, "https://x.co/q/1")).toBe(false);
  });

  /** RFC 9309 §2.3.1.3: "unavailable" means there are no rules. */
  it("allows everything on a 404, because most sites have no robots.txt", async () => {
    const r = await loadRobots("https://x.co", "AltoRank-Auditor", fetcher(404, null));
    expect(r).toEqual(ALLOW_EVERYTHING);
    expect(isAllowed(r, "https://x.co/anything")).toBe(true);
  });

  /**
   * And "unreachable" means the site has rules it will not show us. The
   * conservative half, and the deliberate one: a server that cannot answer for
   * itself does not get crawled by us.
   */
  it("refuses the whole site on a 5xx", async () => {
    const r = await loadRobots("https://x.co", "AltoRank-Auditor", fetcher(503, null));
    expect(isAllowed(r, "https://x.co/anything")).toBe(false);
  });

  it("refuses the whole site when the fetch throws", async () => {
    const r = await loadRobots("https://x.co", "AltoRank-Auditor", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(isAllowed(r, "https://x.co/anything")).toBe(false);
  });

  /** A 200 whose body is the site's own 404 page is not a set of rules. */
  it("treats an HTML body as a soft 404 rather than parsing it", async () => {
    const r = await loadRobots("https://x.co", "AltoRank-Auditor", fetcher(200, "<!doctype html><html>Not found</html>"));
    expect(r).toEqual(ALLOW_EVERYTHING);
  });
});
