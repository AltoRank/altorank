import { describe, expect, it } from "vitest";
import { onSite, PAGES_PER_WORKSPACE, selectCandidates, siteHost, urlKey, type SelectInput } from "../candidates";

const S = "https://acme-agency.example";
const DRAFT_AT = "2026-09-22T10:00:00.000Z";
const draft = { id: "d1", createdAt: DRAFT_AT, rejected: [] as string[] };

function input(over: Partial<SelectInput>): SelectInput {
  return {
    entries: [],
    drafts: [draft],
    host: "acme-agency.example",
    allowed: () => true,
    known: new Map(),
    ledger: new Map(),
    claimed: new Set(),
    ...over,
  };
}

describe("newness", () => {
  it("takes a page whose lastmod is after the draft, and not one from before it", () => {
    const sel = selectCandidates(
      input({
        entries: [
          { loc: `${S}/blog/new`, lastmod: "2026-09-22T10:48:00.000Z" },
          { loc: `${S}/blog/old`, lastmod: "2026-08-01T00:00:00.000Z" },
        ],
      }),
    );
    expect(sel.chosen.map((c) => c.url)).toEqual([`${S}/blog/new`]);
    expect(sel.skipped.notNew).toBe(1);
  });

  it("gives a date-only lastmod a day of slack, since it parses as midnight UTC", () => {
    // Published the same day, 48 minutes after the draft; the sitemap only
    // says "2026-09-22".
    const sel = selectCandidates(input({ entries: [{ loc: `${S}/blog/same-day`, lastmod: "2026-09-22T00:00:00.000Z" }] }));
    expect(sel.chosen).toHaveLength(1);
  });

  it("without a lastmod, takes a page the crawl never saw or first saw after the draft", () => {
    const sel = selectCandidates(
      input({
        entries: [
          { loc: `${S}/blog/unknown`, lastmod: null },
          { loc: `${S}/blog/seen-after`, lastmod: null },
          { loc: `${S}/blog/seen-before`, lastmod: null },
        ],
        known: new Map([
          [urlKey(`${S}/blog/seen-after`), "2026-09-23T00:00:00.000Z"],
          [urlKey(`${S}/blog/seen-before`), "2026-09-01T00:00:00.000Z"],
        ]),
      }),
    );
    expect(sel.chosen.map((c) => c.url)).toEqual([`${S}/blog/unknown`, `${S}/blog/seen-after`]);
    expect(sel.skipped.notNew).toBe(1);
  });

  it("takes a page the crawl first saw after the draft even when its lastmod is stale", () => {
    // A hand-written sitemap entry copied from an older one: the date says
    // August, and the weekly crawl met the page for the first time after the
    // draft existed. The observation wins; a page seen before the draft, or
    // never seen, still goes by its lastmod.
    const stale = "2026-08-01T00:00:00.000Z";
    const sel = selectCandidates(
      input({
        entries: [
          { loc: `${S}/blog/copied-date`, lastmod: stale },
          { loc: `${S}/blog/refresh-target`, lastmod: stale },
          { loc: `${S}/blog/never-crawled`, lastmod: stale },
        ],
        known: new Map([
          [urlKey(`${S}/blog/copied-date`), "2026-09-23T00:00:00.000Z"],
          [urlKey(`${S}/blog/refresh-target`), "2026-09-01T00:00:00.000Z"],
        ]),
      }),
    );
    expect(sel.chosen.map((c) => c.url)).toEqual([`${S}/blog/copied-date`]);
    expect(sel.skipped.notNew).toBe(2);
  });

  it("takes a page the crawl knew before the draft once its lastmod moves after it: it changed, possibly into the draft", () => {
    // A draft pasted over an existing page is found on the site the same way
    // a new page is. The page that did not change stays old.
    const sel = selectCandidates(
      input({
        entries: [
          { loc: `${S}/services/changed`, lastmod: "2026-09-22T11:00:00.000Z" },
          { loc: `${S}/services/unchanged`, lastmod: "2026-08-01T00:00:00.000Z" },
        ],
        known: new Map([
          [urlKey(`${S}/services/changed`), "2026-05-01T00:00:00.000Z"],
          [urlKey(`${S}/services/unchanged`), "2026-05-01T00:00:00.000Z"],
        ]),
      }),
    );
    expect(sel.chosen.map((c) => c.url)).toEqual([`${S}/services/changed`]);
    expect(sel.skipped.notNew).toBe(1);
  });

  it("records per page which drafts it is new for", () => {
    const later = { id: "d2", createdAt: "2026-09-24T10:00:00.000Z", rejected: [] };
    const sel = selectCandidates(
      input({ drafts: [draft, later], entries: [{ loc: `${S}/blog/p`, lastmod: "2026-09-23T09:00:00.000Z" }] }),
    );
    // Published the day before d2 existed: new for d1 only (outside d2's slack).
    expect(sel.chosen[0].draftIds).toEqual(["d1"]);
  });
});

describe("what is never read", () => {
  it("skips pages off the site, non-pages, robots-disallowed pages and pages already an article", () => {
    const sel = selectCandidates(
      input({
        entries: [
          { loc: "https://elsewhere.example/blog/x", lastmod: "2026-09-23T00:00:00Z" },
          { loc: `${S}/files/brochure.pdf`, lastmod: "2026-09-23T00:00:00Z" },
          { loc: `${S}/private/x`, lastmod: "2026-09-23T00:00:00Z" },
          { loc: `${S}/blog/ours/`, lastmod: "2026-09-23T00:00:00Z" },
          { loc: "https://blog.acme-agency.example/post", lastmod: "2026-09-23T00:00:00Z" },
        ],
        allowed: (u) => !u.includes("/private/"),
        claimed: new Set([urlKey("http://www.acme-agency.example/blog/ours")]),
      }),
    );
    expect(sel.skipped).toMatchObject({ offSite: 1, notContent: 1, disallowed: 1, alreadyAnArticle: 1 });
    // A subdomain of the site is the site.
    expect(sel.chosen.map((c) => c.url)).toEqual(["https://blog.acme-agency.example/post"]);
  });

  it("never offers a page a person rejected for that draft", () => {
    const sel = selectCandidates(
      input({
        drafts: [{ ...draft, rejected: [`${S}/blog/not-mine`] }],
        entries: [{ loc: `${S}/blog/not-mine/`, lastmod: "2026-09-23T00:00:00Z" }],
      }),
    );
    expect(sel.chosen).toEqual([]);
  });
});

describe("the ledger", () => {
  it("does not read a page twice unless its lastmod moved past the last read", () => {
    const ledger = new Map([
      [urlKey(`${S}/blog/unchanged`), { checkedAt: "2026-09-23T10:00:00Z" }],
      [urlKey(`${S}/blog/changed`), { checkedAt: "2026-09-23T10:00:00Z" }],
      [urlKey(`${S}/blog/undated`), { checkedAt: "2026-09-23T10:00:00Z" }],
    ]);
    const sel = selectCandidates(
      input({
        ledger,
        entries: [
          { loc: `${S}/blog/unchanged`, lastmod: "2026-09-23T08:00:00Z" },
          { loc: `${S}/blog/changed`, lastmod: "2026-09-24T08:00:00Z" },
          { loc: `${S}/blog/undated`, lastmod: null },
        ],
      }),
    );
    expect(sel.chosen.map((c) => [c.url, c.reread])).toEqual([[`${S}/blog/changed`, true]]);
    expect(sel.skipped.alreadyRead).toBe(2);
  });
});

describe("bounding", () => {
  it(`reads at most ${PAGES_PER_WORKSPACE} pages and counts the rest`, () => {
    const entries = Array.from({ length: 35 }, (_, i) => ({
      loc: `${S}/blog/p${i}`,
      lastmod: new Date(Date.parse(DRAFT_AT) + i * 3_600_000).toISOString(),
    }));
    const sel = selectCandidates(input({ entries }));
    expect(sel.chosen).toHaveLength(PAGES_PER_WORKSPACE);
    expect(sel.skipped.overCap).toBe(15);
    // Newest first: the most recent page is the likeliest copy.
    expect(sel.chosen[0].url).toBe(`${S}/blog/p34`);
  });

  it("puts never-read pages before re-reads, dated before undated", () => {
    const sel = selectCandidates(
      input({
        limit: 3,
        ledger: new Map([[urlKey(`${S}/reread`), { checkedAt: "2026-09-22T12:00:00Z" }]]),
        entries: [
          { loc: `${S}/reread`, lastmod: "2026-09-25T00:00:00Z" },
          { loc: `${S}/undated`, lastmod: null },
          { loc: `${S}/dated`, lastmod: "2026-09-23T00:00:00Z" },
          { loc: `${S}/dated-older`, lastmod: "2026-09-22T12:00:00Z" },
        ],
      }),
    );
    expect(sel.chosen.map((c) => c.url)).toEqual([`${S}/dated`, `${S}/dated-older`, `${S}/undated`]);
    expect(sel.skipped.overCap).toBe(1);
  });
});

describe("urls", () => {
  it("keys one page the same however it is spelled", () => {
    expect(urlKey("https://www.Acme-Agency.example/blog/a/")).toBe(urlKey("http://acme-agency.example/blog/a#top"));
    expect(urlKey("https://acme-agency.example/")).toBe("acme-agency.example/");
    expect(urlKey("https://acme-agency.example/a?x=1")).not.toBe(urlKey("https://acme-agency.example/a"));
  });

  it("reads the host from a domain however the workspace stored it", () => {
    expect(siteHost("acme-agency.example")).toBe("acme-agency.example");
    expect(siteHost("https://www.acme-agency.example/tr/")).toBe("acme-agency.example");
    expect(onSite("https://www.acme-agency.example/x", "acme-agency.example")).toBe(true);
    expect(onSite("https://notacme-agency.example/x", "acme-agency.example")).toBe(false);
  });
});
