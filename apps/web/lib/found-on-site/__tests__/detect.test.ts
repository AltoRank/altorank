import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SafeFetch, SafeFetchResult } from "@/lib/public-tools/safe-fetch";
import { FetchFailedError } from "@/lib/public-tools/safe-fetch";
import { fakeSupabase, type Seed } from "@/lib/agent/__tests__/fake-supabase";
import { findDraftsLiveOnSites } from "../detect";
import * as F from "./fixtures";

// The nightly check end to end, against an in-memory database and a fake
// site: robots.txt, a sitemap index, and pages built from the fixtures. No
// network, no paid call.

const S = "https://acme-agency.example";
const NIGHT_1 = new Date("2026-09-23T10:00:00.000Z");
const NIGHT_2 = new Date("2026-09-24T10:00:00.000Z");
const DRAFTED = "2026-09-22T10:00:00.000Z";

const urlset = (rows: Array<[string, string]>) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows
    .map(([p, lastmod]) => `<url><loc>${S}${p}</loc><lastmod>${lastmod}</lastmod></url>`)
    .join("")}</urlset>`;

type Page = { status?: number; body: string; type?: string; redirectTo?: string };

function fakeSite(pages: Record<string, Page>, onFetch?: (url: string) => void) {
  const calls: string[] = [];
  const fetch: SafeFetch = async (url) => {
    calls.push(url);
    onFetch?.(url);
    const p = pages[url];
    if (!p) {
      if (url.endsWith("/robots.txt")) return result(url, url, 404, "", "text/plain");
      return result(url, url, 404, "<!doctype html><p>Sayfa bulunamadı</p>", "text/html");
    }
    return result(url, p.redirectTo ?? url, p.status ?? 200, p.body, p.type ?? "text/html; charset=utf-8");
  };
  return { fetch, calls };
}

function result(requestedUrl: string, url: string, status: number, body: string, type: string): SafeFetchResult {
  const buf = Buffer.from(body);
  return {
    requestedUrl, url, status, headers: { "content-type": type }, body, bodyBuffer: buf, bytes: buf.length,
    truncated: false, redirects: [], tlsUnverified: false, timeMs: 1,
  };
}

const ROBOTS = `User-agent: *\nDisallow: /private/\nSitemap: ${S}/sitemap_index.xml\n`;

/** The site the morning after: the Turkish draft copied 48 minutes after it was written. */
function site(extra: Record<string, Page> = {}) {
  return {
    [`${S}/robots.txt`]: { body: ROBOTS, type: "text/plain" },
    [`${S}/sitemap_index.xml`]: {
      type: "application/xml",
      body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${S}/post-sitemap.xml</loc><lastmod>2026-09-22</lastmod></sitemap></sitemapindex>`,
    },
    [`${S}/post-sitemap.xml`]: {
      type: "application/xml",
      body: urlset([
        ["/blog/sadakat-programi-rehberi", "2026-09-22T10:48:00+00:00"],
        ["/blog/standing-desk-guide", "2026-09-22T18:00:00+00:00"],
        ["/hizmetler", "2026-09-23T08:00:00+00:00"],
        ["/blog/eski-yazi", "2026-08-01T09:00:00+00:00"],
        ["/private/taslak", "2026-09-23T09:00:00+00:00"],
      ]),
    },
    [`${S}/blog/sadakat-programi-rehberi`]: { body: F.TR_COPY_PAGE },
    [`${S}/blog/standing-desk-guide`]: { body: F.EN_SAME_OUTLINE_PAGE },
    [`${S}/hizmetler`]: { body: F.UNRELATED_PAGE },
    [`${S}/blog/eski-yazi`]: { body: F.UNRELATED_PAGE },
    [`${S}/private/taslak`]: { body: F.TR_COPY_PAGE },
    ...extra,
  };
}

function seed(over: Partial<Seed> = {}): Seed {
  return {
    workspaces: [{ id: "ws-1", domain: "acme-agency.example", found_on_site_checked_at: null }],
    articles: [
      {
        id: "tr-draft", workspace_id: "ws-1", title: F.TR_DRAFT.title, content: F.draftDoc(F.TR_DRAFT), status: "review",
        created_at: DRAFTED, published_url: null, published_at: null, found_on_site_at: null, found_on_site_rejected: [],
      },
      {
        id: "en-draft", workspace_id: "ws-1", title: F.EN_DRAFT.title, content: F.draftDoc(F.EN_DRAFT), status: "approved",
        created_at: DRAFTED, published_url: null, published_at: null, found_on_site_at: null, found_on_site_rejected: [],
      },
    ],
    site_pages: [],
    found_on_site_checks: [],
    ...over,
  };
}

const client = (sb: ReturnType<typeof fakeSupabase>) => sb as unknown as SupabaseClient;
const article = (sb: ReturnType<typeof fakeSupabase>, id: string) => sb.tables.articles.find((a) => a.id === id)!;

describe("findDraftsLiveOnSites", () => {
  it("finds the lightly edited copy and records it on the publish record", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site());
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });

    expect(run).toMatchObject({ considered: 1, checked: 1, found: 1, deferred: 0 });
    const tr = article(sb, "tr-draft");
    expect(tr.status).toBe("live");
    expect(tr.published_url).toBe(`${S}/blog/sadakat-programi-rehberi`);
    // The sitemap's date is after the draft and before tonight, so it is the publish date.
    expect(tr.published_at).toBe("2026-09-22T10:48:00.000Z");
    expect(tr.found_on_site_at).toBe(NIGHT_1.toISOString());
    expect(tr.found_on_site_prior).toEqual({ status: "review", published_url: null, published_at: null });
    const evidence = tr.found_on_site_evidence as { containment: number; rule: string; url: string };
    expect(evidence.containment).toBeGreaterThanOrEqual(0.5);
    expect(evidence.rule).toBe("text");

    // The same-outline English article is on the same site and is not our draft.
    expect(article(sb, "en-draft").status).toBe("approved");
    expect(article(sb, "en-draft").found_on_site_at).toBeNull();
  });

  it("reads robots.txt first, obeys it, and reads only pages new since the draft", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site());
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });

    expect(s.calls[0]).toBe(`${S}/robots.txt`);
    expect(s.calls).not.toContain(`${S}/private/taslak`); // Disallow: /private/
    expect(s.calls).not.toContain(`${S}/blog/eski-yazi`); // August: older than the draft
    expect(s.calls).toEqual(expect.arrayContaining([`${S}/blog/sadakat-programi-rehberi`, `${S}/blog/standing-desk-guide`, `${S}/hizmetler`]));
    expect(run.results[0].skipped).toMatchObject({ disallowed: 1, notNew: 1 });
    // Every page read goes in the ledger, matched or not.
    const ledger = sb.tables.found_on_site_checks;
    expect(ledger.map((r) => r.url).sort()).toEqual([`${S}/blog/sadakat-programi-rehberi`, `${S}/blog/standing-desk-guide`, `${S}/hizmetler`]);
    expect(ledger.find((r) => r.url === `${S}/blog/sadakat-programi-rehberi`)?.matched_article_id).toBe("tr-draft");
    expect(sb.tables.workspaces[0].found_on_site_checked_at).toBe(NIGHT_1.toISOString());
  });

  it("is idempotent: the second night reads no page again and records nothing new", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site());
    await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    const articleWrites = sb.writes.filter((w) => w.table === "articles").length;
    const ledgerRows = sb.tables.found_on_site_checks.length;
    const trAfterFirst = { ...article(sb, "tr-draft") };

    s.calls.length = 0;
    const run2 = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_2 });

    // The English draft is still unpublished, so the site is still looked at...
    expect(run2).toMatchObject({ considered: 1, checked: 1, found: 0 });
    // ...but only robots.txt and the sitemaps are read: every page is in the ledger.
    expect(s.calls).toEqual([`${S}/robots.txt`, `${S}/sitemap_index.xml`, `${S}/post-sitemap.xml`]);
    expect(run2.results[0].skipped?.alreadyRead).toBe(2);
    expect(run2.results[0].skipped?.alreadyAnArticle).toBe(1); // the copy is now the Turkish draft's URL
    expect(sb.writes.filter((w) => w.table === "articles")).toHaveLength(articleWrites);
    expect(sb.tables.found_on_site_checks).toHaveLength(ledgerRows);
    expect(article(sb, "tr-draft")).toEqual(trAfterFirst);
  });

  it("reads a page again when its lastmod moves past the last read, and finds a copy made in place", async () => {
    const sb = fakeSupabase(seed());
    const first = fakeSite(site());
    await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: first.fetch, now: () => NIGHT_1 });

    // The next day the services page is replaced with the English draft, lightly edited.
    const changed = site({
      [`${S}/post-sitemap.xml`]: {
        type: "application/xml",
        body: urlset([
          ["/blog/sadakat-programi-rehberi", "2026-09-22T10:48:00+00:00"],
          ["/blog/standing-desk-guide", "2026-09-22T18:00:00+00:00"],
          ["/hizmetler", "2026-09-24T07:00:00+00:00"],
        ]),
      },
      [`${S}/hizmetler`]: { body: F.EN_COPY_PAGE },
    });
    const second = fakeSite(changed);
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: second.fetch, now: () => NIGHT_2 });
    expect(second.calls).toContain(`${S}/hizmetler`);
    expect(second.calls).not.toContain(`${S}/blog/standing-desk-guide`);
    expect(run.found).toBe(1);
    expect(article(sb, "en-draft")).toMatchObject({ status: "live", published_url: `${S}/hizmetler` });
    expect(article(sb, "en-draft").found_on_site_prior).toMatchObject({ status: "approved" });
  });

  it("leaves an article alone if a person changed it while the page was being read", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site(), (url) => {
      if (url === `${S}/blog/sadakat-programi-rehberi`) article(sb, "tr-draft").status = "approved";
    });
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run.found).toBe(0);
    expect(article(sb, "tr-draft")).toMatchObject({ status: "approved", found_on_site_at: null, published_url: null });
  });

  it("never matches a page a person already said is not this article", async () => {
    const base = seed();
    (base.articles[0] as Record<string, unknown>).found_on_site_rejected = [`${S}/blog/sadakat-programi-rehberi/`];
    const sb = fakeSupabase(base);
    const s = fakeSite(site());
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run.found).toBe(0);
    expect(article(sb, "tr-draft").status).toBe("review");
  });

  it("does not take a page that redirects off the site", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site({
      [`${S}/blog/sadakat-programi-rehberi`]: { body: F.TR_COPY_PAGE, redirectTo: "https://login.elsewhere.example/" },
    }));
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run.found).toBe(0);
  });

  it("does not read a site whose robots.txt does not answer", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site({ [`${S}/robots.txt`]: { status: 503, body: "", type: "text/plain" } }));
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(s.calls).toEqual([`${S}/robots.txt`]);
    expect(run.results[0]).toMatchObject({ status: "skipped", detail: expect.stringContaining("robots.txt did not answer") });
    expect(article(sb, "tr-draft").status).toBe("review");
  });

  it("tries a page that did not answer again tomorrow, rather than recording it as read", async () => {
    const sb = fakeSupabase(seed());
    const flaky = fakeSite(site());
    const fetch: SafeFetch = async (url, o) => {
      if (url === `${S}/hizmetler`) throw new FetchFailedError("timed out", url);
      return flaky.fetch(url, o);
    };
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch, now: () => NIGHT_1 });
    expect(run.results[0]).toMatchObject({ read: 2, unread: 1 });
    expect(sb.tables.found_on_site_checks.map((r) => r.url)).not.toContain(`${S}/hizmetler`);
  });

  it("says so when a site has no sitemap to read", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite({ [`${S}/robots.txt`]: { body: "User-agent: *\nDisallow:\n", type: "text/plain" } });
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run.results[0]).toMatchObject({ status: "checked", sitemapUrls: 0, detail: expect.stringContaining("no sitemap could be read") });
  });

  it("reads at most twenty pages a night and says how many it left", async () => {
    const rows: Array<[string, string]> = Array.from({ length: 25 }, (_, i) => [`/blog/p${i}`, `2026-09-22T${String(11 + (i % 12)).padStart(2, "0")}:00:00+00:00`]);
    const pages: Record<string, Page> = {};
    for (const [p] of rows) pages[`${S}${p}`] = { body: F.UNRELATED_PAGE };
    const sb = fakeSupabase(seed());
    const s = fakeSite(site({ [`${S}/post-sitemap.xml`]: { type: "application/xml", body: urlset(rows) }, ...pages }));
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run.results[0]).toMatchObject({ read: 20 });
    expect(run.results[0].skipped?.overCap).toBe(5);
  });

  it("defers a site the night's time does not reach, without stamping it", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site());
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 0, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run).toMatchObject({ considered: 1, checked: 0, deferred: 1 });
    expect(s.calls).toEqual([]);
    expect(sb.tables.workspaces[0].found_on_site_checked_at).toBeNull();
  });

  it("looks for nothing when every recent draft is already live or older than thirty days", async () => {
    const sb = fakeSupabase(
      seed({
        articles: [
          { id: "a", workspace_id: "ws-1", title: "t", content: {}, status: "live", created_at: DRAFTED, found_on_site_at: null },
          { id: "b", workspace_id: "ws-1", title: "t", content: {}, status: "review", created_at: "2026-07-01T00:00:00Z", found_on_site_at: null },
        ],
      }),
    );
    const s = fakeSite(site());
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run).toMatchObject({ considered: 0, checked: 0 });
    expect(s.calls).toEqual([]);
  });
});
