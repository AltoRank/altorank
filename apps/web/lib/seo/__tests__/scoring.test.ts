import { describe, it, expect } from "vitest";
import { scoreArticle } from "../scoring";

// The internal-link check used to count any absolute URL not on five named
// social hosts as internal, and `href="#"` too. So a draft citing HubSpot twice
// with one dead anchor passed "Internal links: 3+" while linking to nothing on
// its own site. Given the domain, the check now means what its label says.

const check = (html: string, siteDomain?: string | null) =>
  scoreArticle(html, "widgets", { siteDomain }).checks.find((c) => c.name === "internalLinks")!;

const HTML = `<h1>Widgets</h1>
<p><a href="/blog/widget-pricing">pricing</a>
<a href="https://www.example.com/blog/widget-types">types</a>
<a href="https://blog.hubspot.com/widgets">a HubSpot report</a>
<a href="#">read more</a>
<a href="#pricing">jump to pricing</a>
<a href="{{internal-link:widget sizes}}">sizes</a></p>`;

const by = (html: string, name: string, opts: Parameters<typeof scoreArticle>[2] = {}) =>
  scoreArticle(html, "widgets", opts).checks.find((c) => c.name === name)!;

describe("scoreArticle — rebalanced checks", () => {
  it("passes density between 0.5% and 2%, and scores stuffing as zero", () => {
    const words = (n: number, kw: number) =>
      `<h1>Widgets</h1><p>${"widgets ".repeat(kw)}${"filler ".repeat(n - kw)}</p>`;
    expect(by(words(200, 2), "keywordDensity").passed).toBe(true); // 1.0%
    expect(by(words(200, 5), "keywordDensity").passed).toBe(false); // 2.5%
    const stuffed = by(words(100, 5), "keywordDensity"); // 5%
    expect(stuffed.score).toBe(0);
    expect(stuffed.note).toContain("stuffing");
  });

  it("scores title length for the result line, from the H1 or the stored title", () => {
    expect(by("<h1>Widgets</h1>", "titleLength").passed).toBe(false);
    expect(by("<h1>The Best Widgets for Small Teams in 2026</h1>", "titleLength").passed).toBe(true);
    const long = by("<h1>x</h1>", "titleLength", {
      title: "A Very Long Title That Keeps Going Well Past The Point Where Google Stops Showing It",
    });
    expect(long.passed).toBe(false);
    expect(long.note).toContain("truncates");
  });

  it("wants the keyword in the meta description, not only the right length", () => {
    const html = "<h1>Widgets</h1><p>x</p>";
    const good = "x".repeat(60) + " widgets " + "y".repeat(60);
    const noKw = "x".repeat(130);
    expect(by(html, "metaDescriptionLength", { metaDescription: good }).passed).toBe(true);
    const c = by(html, "metaDescriptionLength", { metaDescription: noKw });
    expect(c.passed).toBe(false);
    expect(c.note).toContain("keyword missing");
  });

  it("measures length against the SERP-derived target when given one", () => {
    const html = `<h1>Widgets</h1><p>${"word ".repeat(600)}</p>`;
    // Flat 1,500 fails a 600-word transactional piece the research asked for.
    expect(by(html, "wordCount").passed).toBe(false);
    const c = by(html, "wordCount", { targetWordCount: 650 });
    expect(c.passed).toBe(true);
    expect(c.note).toContain("from what ranks");
  });

  it("weights still sum to one, so a perfect draft scores 100", () => {
    // Twelve-word sentences, so readability lands in its 10-25 band, and the
    // keyword about seven times in ~530 words, so density lands in 0.5-2%.
    const filler = "This sentence explains one useful thing about the topic in twelve words. ";
    const withKw = "Small teams pick widgets for the metered pricing and simple setup. ";
    const html =
      "<h1>The Best Widgets for Small Teams in 2026</h1>" +
      `<p>Widgets are small. ${filler.repeat(20)}${withKw}</p>` +
      "<h2>Why widgets?</h2>" +
      `<p>${filler.repeat(10)}${withKw}</p>` +
      "<h2>Which widgets?</h2>" +
      `<p>${filler.repeat(10)}${withKw}</p>` +
      '<p><a href="/a">Pricing guide.</a> <a href="/b">Setup guide.</a> <a href="/c">Comparison table.</a></p>';
    const r = scoreArticle(html, "widgets", {
      metaDescription: "Widgets compared for small teams: " + "x".repeat(100),
      targetWordCount: 500,
    });
    expect(r.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([]);
    expect(r.score).toBe(100);
  });
});

describe("scoreArticle — internal links", () => {
  it("counts only links to the site when it knows the site", () => {
    const c = check(HTML, "example.com");
    expect(c.note).toBe("Internal links found: 2 (target: 3+)");
    expect(c.passed).toBe(false);
  });

  it("never counts a dead anchor, a jump link or an unresolved placeholder", () => {
    const dead = `<h1>W</h1><p><a href="#">a</a><a href="#top">b</a><a href="{{internal-link:x}}">c</a></p>`;
    expect(check(dead, "example.com").note).toContain("found: 0");
    expect(check(dead).note).toContain("found: 0");
  });

  it("without a domain, falls back to the old heuristic minus the dead anchors", () => {
    // Relative paths and non-social absolute URLs count, as before; `#` and
    // the placeholder no longer do. 3 rather than the 5 the old code reported.
    const c = check(HTML);
    expect(c.note).toBe("Internal links found: 3 (target: 3+)");
  });

  it("accepts the domain however the workspace stored it", () => {
    for (const d of ["https://www.example.com/", "Example.com", "www.example.com"]) {
      expect(check(HTML, d).note).toContain("found: 2");
    }
  });

  it("treats a subdomain of the site as the site", () => {
    const html = `<h1>W</h1><p><a href="https://docs.example.com/x">a</a><a href="https://example.com/y">b</a><a href="https://example.org/z">c</a></p>`;
    expect(check(html, "example.com").note).toContain("found: 2");
  });
});
