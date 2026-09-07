import { describe, it, expect } from "vitest";
import {
  canonicalOf,
  checkPage,
  countH1,
  countImages,
  duplicateFindings,
  openGraphOf,
  robotsDirectivesOf,
  summarise,
  TECH_CHECK_INFO,
  TECH_LIMITS,
  type TechCheck,
  type TechFacts,
} from "../tech-audit";

/** A page with nothing wrong with it, to vary one fact at a time. */
const CLEAN: TechFacts = {
  url: "https://x.co/blog/widget-pricing",
  finalUrl: "https://x.co/blog/widget-pricing",
  status: 200,
  redirects: [],
  tlsUnverified: false,
  pageType: "article",
  title: "Widget pricing explained, from setup to renewal",
  metaDescription:
    "What vendors charge per widget per month, what the setup fee covers, and how renewals are priced across the three common contract shapes.",
  h1Count: 1,
  wordCount: 1200,
  canonical: "https://x.co/blog/widget-pricing",
  robotsDirectives: [],
  images: 3,
  imagesMissingAlt: 0,
  internalLinks: 4,
  externalLinks: 2,
  jsonLdTypes: ["Article"],
  openGraph: ["og:title", "og:image"],
};

const codes = (facts: Partial<TechFacts>): TechCheck[] =>
  checkPage({ ...CLEAN, ...facts }).map((f) => f.code);

describe("checkPage", () => {
  it("says nothing about a page that has nothing wrong with it", () => {
    expect(checkPage(CLEAN)).toEqual([]);
  });

  /**
   * The one that matters most. A 404 has no title, no H1 and no meta
   * description either, and reporting those would be three true statements
   * that mean the same thing and bury the one that does not.
   */
  it("reports a dead page once, and says nothing else about it", () => {
    const found = checkPage({ ...CLEAN, status: 404, title: null, h1Count: 0, metaDescription: null });
    expect(found).toEqual([
      { code: "http_error", severity: "error", message: "The server returned 404 for this URL." },
    ]);
  });

  it("distinguishes a server that did not answer from one that said no", () => {
    expect(checkPage({ ...CLEAN, status: 0 })[0].message).toBe("The server did not answer for this URL.");
  });

  it("calls one hop a note and several a problem", () => {
    const one = checkPage({ ...CLEAN, redirects: [{ status: 301, from: "a", to: "b" }] });
    expect(one[0]).toMatchObject({ code: "redirect_chain", severity: "info" });
    const three = checkPage({
      ...CLEAN,
      redirects: [
        { status: 301, from: "a", to: "b" },
        { status: 301, from: "b", to: "c" },
        { status: 302, from: "c", to: "d" },
      ],
    });
    expect(three[0]).toMatchObject({ code: "redirect_chain", severity: "warning" });
    expect(three[0].message).toContain("3 redirects");
  });

  it("reports a title that is missing, short or long, and nothing in between", () => {
    expect(codes({ title: null })).toEqual(["title_missing"]);
    expect(codes({ title: "Pricing" })).toEqual(["title_length"]);
    expect(codes({ title: "x".repeat(TECH_LIMITS.titleMax + 1) })).toEqual(["title_length"]);
    expect(codes({ title: "x".repeat(TECH_LIMITS.titleMax) })).toEqual([]);
  });

  it("reports a meta description that is missing, short or long", () => {
    expect(codes({ metaDescription: null })).toEqual(["meta_description_missing"]);
    expect(codes({ metaDescription: "Too short." })).toEqual(["meta_description_length"]);
    expect(codes({ metaDescription: "x".repeat(TECH_LIMITS.metaMax + 1) })).toEqual(["meta_description_length"]);
  });

  it("wants exactly one H1", () => {
    expect(codes({ h1Count: 0 })).toEqual(["h1_missing"]);
    expect(codes({ h1Count: 2 })).toEqual(["h1_multiple"]);
    expect(checkPage({ ...CLEAN, h1Count: 3 })[0].message).toContain("3 H1");
  });

  /** A pricing page in forty words is a pricing page, not a thin article. */
  it("calls only an article thin", () => {
    expect(codes({ wordCount: 40 })).toEqual(["thin_content"]);
    expect(codes({ wordCount: 40, pageType: "page" })).toEqual([]);
    expect(codes({ wordCount: 40, pageType: "listing" })).toEqual([]);
    expect(codes({ wordCount: TECH_LIMITS.thinWords })).toEqual([]);
  });

  it("reports a page that is in the sitemap and also noindex", () => {
    expect(codes({ robotsDirectives: ["noindex", "follow"] })).toEqual(["noindex"]);
    expect(codes({ robotsDirectives: ["none"] })).toEqual(["noindex"]);
    expect(codes({ robotsDirectives: ["nofollow"] })).toEqual(["nofollow"]);
    expect(codes({ robotsDirectives: ["index", "follow"] })).toEqual([]);
  });

  it("reports a missing canonical, and one that points somewhere else", () => {
    expect(codes({ canonical: null })).toEqual(["canonical_missing"]);
    expect(codes({ canonical: "https://x.co/other" })).toEqual(["canonical_elsewhere"]);
  });

  /** Trailing slash, `www.` and scheme are not a different page. */
  it("accepts a canonical that differs only cosmetically", () => {
    expect(codes({ canonical: "https://www.x.co/blog/widget-pricing/" })).toEqual([]);
  });

  it("counts the images with no alt, and names the total", () => {
    const found = checkPage({ ...CLEAN, images: 9, imagesMissingAlt: 4 });
    expect(found[0]).toMatchObject({ code: "images_missing_alt", severity: "warning" });
    expect(found[0].message).toBe("4 of 9 images have no alt text.");
  });

  it("reports a page nothing leads out of", () => {
    expect(codes({ internalLinks: 0 })).toEqual(["no_internal_links"]);
  });

  it("reports missing structured data and Open Graph separately", () => {
    expect(codes({ jsonLdTypes: [] })).toEqual(["no_structured_data"]);
    expect(codes({ openGraph: [] })).toEqual(["open_graph_missing"]);
  });

  it("reports a chain it could not verify", () => {
    expect(codes({ tlsUnverified: true })).toEqual(["tls_chain"]);
  });

  it("has a label and a reason for every code it can emit", () => {
    const emitted = new Set<TechCheck>();
    for (const facts of [
      { status: 404 },
      { status: 0 },
      { redirects: [{ status: 301, from: "a", to: "b" }] },
      { tlsUnverified: true },
      { title: null },
      { title: "short" },
      { metaDescription: null },
      { metaDescription: "short" },
      { h1Count: 0 },
      { h1Count: 2 },
      { wordCount: 10 },
      { canonical: null },
      { canonical: "https://x.co/z" },
      { robotsDirectives: ["noindex"] },
      { robotsDirectives: ["nofollow"] },
      { imagesMissingAlt: 1 },
      { internalLinks: 0 },
      { jsonLdTypes: [] },
      { openGraph: [] },
    ] as Partial<TechFacts>[]) {
      for (const c of codes(facts)) emitted.add(c);
    }
    // Both cross-page codes are only reachable through duplicateFindings.
    emitted.add("duplicate_title");
    emitted.add("duplicate_meta_description");
    for (const code of emitted) {
      expect(TECH_CHECK_INFO[code]?.label, code).toBeTruthy();
      expect(TECH_CHECK_INFO[code]?.why, code).toBeTruthy();
    }
    expect(emitted.size).toBe(Object.keys(TECH_CHECK_INFO).length);
  });
});

describe("extraction from real markup", () => {
  it("counts images with no alt, and leaves decorative ones alone", () => {
    const html = `
      <img src="/a.png" alt="A chart of prices">
      <img src="/b.png">
      <img src='/c.png' alt=''>
      <img src="/spacer.gif" aria-hidden="true">
      <img src="/d.png" role="presentation">
      <img src="/e.png" width="20">`;
    expect(countImages(html)).toEqual({ total: 6, missingAlt: 2 });
  });

  it("counts H1s however they are written", () => {
    expect(countH1('<h1>One</h1><H1 class="x">Two</H1><h10>no</h10>')).toBe(2);
  });

  it("resolves a relative canonical against the page it is on", () => {
    expect(canonicalOf('<link rel="canonical" href="/blog/x">', "https://x.co/blog/x?utm=1")).toBe(
      "https://x.co/blog/x",
    );
  });

  it("reads a canonical whose attributes are the other way round", () => {
    expect(canonicalOf('<link href="https://x.co/a" rel="canonical">', "https://x.co/a")).toBe("https://x.co/a");
  });

  it("returns null when there is no canonical", () => {
    expect(canonicalOf('<link rel="alternate" href="/feed">', "https://x.co/a")).toBeNull();
  });

  /** Both places a directive can be written, merged, because both apply. */
  it("merges robots directives from the meta tag and the header", () => {
    const d = robotsDirectivesOf('<meta name="robots" content="index, follow">', {
      "x-robots-tag": "googlebot: noindex",
    });
    expect(d).toContain("index");
    expect(d).toContain("noindex");
  });

  it("reads a googlebot-only meta tag, because a page hidden from Google is hidden", () => {
    expect(robotsDirectivesOf('<meta name="googlebot" content="noindex">', {})).toContain("noindex");
  });

  it("lists the Open Graph properties that are there", () => {
    const og = openGraphOf('<meta property="og:title" content="x"><meta property="og:image" content="y">');
    expect(og).toEqual(["og:title", "og:image"]);
  });
});

describe("duplicateFindings", () => {
  const page = (url: string, title: string | null, meta: string | null = null, status = 200) => ({
    url,
    title,
    metaDescription: meta,
    status,
  });

  it("flags every page sharing a title, and says how many", () => {
    const found = duplicateFindings([
      page("https://x.co/a", "Home"),
      page("https://x.co/b", "Home"),
      page("https://x.co/c", "Different"),
    ]);
    expect(found.get("https://x.co/a")).toEqual([
      { code: "duplicate_title", severity: "warning", message: "2 pages share this title." },
    ]);
    expect(found.get("https://x.co/b")).toHaveLength(1);
    expect(found.has("https://x.co/c")).toBe(false);
  });

  it("matches case-insensitively and ignores surrounding space", () => {
    const found = duplicateFindings([page("https://x.co/a", " Home "), page("https://x.co/b", "home")]);
    expect(found.size).toBe(2);
  });

  /** "No title" is already its own finding; forty pages of it is not a duplicate. */
  it("does not call two blanks a duplicate", () => {
    expect(duplicateFindings([page("https://x.co/a", null), page("https://x.co/b", "")]).size).toBe(0);
  });

  it("ignores pages that did not load", () => {
    expect(duplicateFindings([page("https://x.co/a", "T", null, 404), page("https://x.co/b", "T", null, 500)]).size).toBe(0);
  });

  it("reports titles and descriptions separately", () => {
    const found = duplicateFindings([page("https://x.co/a", "T", "D"), page("https://x.co/b", "T", "D")]);
    expect(found.get("https://x.co/a")?.map((f) => f.code)).toEqual([
      "duplicate_title",
      "duplicate_meta_description",
    ]);
  });
});

describe("summarise", () => {
  it("counts pages, findings and severities, worst check first", () => {
    const s = summarise([
      { findings: [{ code: "http_error", severity: "error", message: "" }] },
      {
        findings: [
          { code: "meta_description_missing", severity: "warning", message: "" },
          { code: "no_structured_data", severity: "info", message: "" },
        ],
      },
      { findings: [{ code: "no_structured_data", severity: "info", message: "" }] },
      { findings: [] },
    ]);
    expect(s).toMatchObject({ pages: 4, pagesWithIssues: 3, findings: 4, errors: 1, warnings: 1, infos: 2 });
    expect(s.byCheck.map((c) => c.code)).toEqual(["http_error", "meta_description_missing", "no_structured_data"]);
    expect(s.byCheck.find((c) => c.code === "no_structured_data")?.pages).toBe(2);
  });

  it("counts a check once per page even if it fires twice on it", () => {
    const s = summarise([
      {
        findings: [
          { code: "images_missing_alt", severity: "warning", message: "" },
          { code: "images_missing_alt", severity: "warning", message: "" },
        ],
      },
    ]);
    expect(s.findings).toBe(2);
    expect(s.byCheck[0].pages).toBe(1);
  });
});
