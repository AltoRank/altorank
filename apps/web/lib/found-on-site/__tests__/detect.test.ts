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

  it("does not read a site whose robots.txt does not answer, and says it cannot see it", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site({ [`${S}/robots.txt`]: { status: 503, body: "", type: "text/plain" } }));
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(s.calls).toEqual([`${S}/robots.txt`]);
    expect(run.results[0]).toMatchObject({
      status: "unreadable",
      blind: "robots-unanswered",
      newlyUnreadable: true,
      detail: expect.stringContaining("robots.txt did not answer"),
    });
    expect(run).toMatchObject({ checked: 0, unreadable: 1 });
    expect(sb.tables.workspaces[0].found_on_site_unreadable).toBe("robots-unanswered");
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

  it("treats a server error on a page as no answer, not as a page that was read", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site({ [`${S}/hizmetler`]: { status: 503, body: "busy" } }));
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run.results[0]).toMatchObject({ read: 2, unread: 1 });
    expect(sb.tables.found_on_site_checks.map((r) => r.url)).not.toContain(`${S}/hizmetler`);
  });

  it("goes on with the site's other drafts when one draft's body cannot be rendered", async () => {
    const base = seed();
    // A node the renderer does not expect, where text should be.
    (base.articles[1] as Record<string, unknown>).content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text" }] }, null] };
    const sb = fakeSupabase(base);
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: fakeSite(site()).fetch, now: () => NIGHT_1 });
    expect(run.results[0].status).toBe("checked");
    expect(run.found).toBe(1);
  });

  it("reads the whole ledger, past the 1,000 rows one response carries", async () => {
    // 1,200 earlier reads sort before the copy's URL, so its row is on the
    // second page. Truncated at the first, the copy would look unread and be
    // fetched again every night.
    const earlier = Array.from({ length: 1200 }, (_, i) => ({
      workspace_id: "ws-1", url: `${S}/a/p${String(i).padStart(4, "0")}`, checked_at: "2026-09-22T12:00:00Z",
    }));
    const sb = fakeSupabase(seed({
      found_on_site_checks: [...earlier, { workspace_id: "ws-1", url: `${S}/blog/sadakat-programi-rehberi`, checked_at: "2026-09-22T12:00:00Z" }],
    }));
    const s = fakeSite(site());
    await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(s.calls).not.toContain(`${S}/blog/sadakat-programi-rehberi`);
  });

  it("fails the site, not the night, when what is known about it cannot be read", async () => {
    const sb = fakeSupabase(seed());
    const from = sb.from;
    const broken = ((t: string) => {
      const q = from(t) as Record<string, unknown>;
      if (t === "site_pages") q.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "timeout" } }).then(r);
      return q;
    }) as typeof sb.from;
    const run = await findDraftsLiveOnSites({ ...sb, from: broken } as unknown as SupabaseClient, { budgetMs: 60_000, fetch: fakeSite(site()).fetch, now: () => NIGHT_1 });
    expect(run.results[0]).toMatchObject({ status: "error", detail: "site_pages: timeout" });
    expect(article(sb, "tr-draft").status).toBe("review");
  });

  it("says so when the visit cannot be stamped on the site, rather than leave the queue stuck without a reason", async () => {
    const sb = fakeSupabase(seed());
    const from = sb.from;
    const broken = ((t: string) => {
      const q = from(t) as Record<string, unknown>;
      if (t === "workspaces") q.update = () => ({ eq: async () => ({ data: null, error: { message: "stamp refused" } }) });
      return q;
    }) as typeof sb.from;
    const run = await findDraftsLiveOnSites({ ...sb, from: broken } as unknown as SupabaseClient, { budgetMs: 60_000, fetch: fakeSite(site()).fetch, now: () => NIGHT_1 });
    expect(run.results[0]).toMatchObject({ status: "error", detail: expect.stringContaining("could not be recorded on the site: stamp refused") });
    expect(run.checked).toBe(0);
    // The find itself stands: it was written on the article before the stamp.
    expect(run.found).toBe(1);
  });

  it("does not count a site with no sitemap as checked: it cannot see it, and says so", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite({ [`${S}/robots.txt`]: { body: "User-agent: *\nDisallow:\n", type: "text/plain" } });
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run.results[0]).toMatchObject({
      status: "unreadable",
      blind: "no-sitemap",
      sitemapUrls: 0,
      detail: expect.stringContaining("no sitemap could be read"),
    });
    expect(run).toMatchObject({ checked: 0, unreadable: 1 });
    expect(sb.tables.workspaces[0].found_on_site_unreadable).toBe("no-sitemap");

    // The second night it is still unreadable, but it is no longer news.
    const again = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_2 });
    expect(again.results[0]).toMatchObject({ status: "unreadable", blind: "no-sitemap" });
    expect(again.results[0].newlyUnreadable).toBeUndefined();
  });

  it("says so when the sitemap lists nothing, or nothing on this site", async () => {
    const empty = fakeSupabase(seed());
    const bare = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    const s1 = fakeSite(site({ [`${S}/post-sitemap.xml`]: { type: "application/xml", body: bare } }));
    const r1 = await findDraftsLiveOnSites(client(empty), { budgetMs: 60_000, fetch: s1.fetch, now: () => NIGHT_1 });
    expect(r1.results[0]).toMatchObject({ status: "unreadable", blind: "empty-sitemap" });

    const elsewhere = fakeSupabase(seed());
    const other = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://old-name.example/blog/a</loc></url></urlset>`;
    const s2 = fakeSite(site({ [`${S}/post-sitemap.xml`]: { type: "application/xml", body: other } }));
    const r2 = await findDraftsLiveOnSites(client(elsewhere), { budgetMs: 60_000, fetch: s2.fetch, now: () => NIGHT_1 });
    expect(r2.results[0]).toMatchObject({ status: "unreadable", blind: "empty-sitemap", detail: expect.stringContaining("no pages on acme-agency.example") });
  });

  it("says so when robots.txt forbids every page the sitemap lists", async () => {
    const sb = fakeSupabase(seed());
    const s = fakeSite(site({ [`${S}/robots.txt`]: { body: `User-agent: *\nDisallow: /\nSitemap: ${S}/sitemap_index.xml\n`, type: "text/plain" } }));
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: s.fetch, now: () => NIGHT_1 });
    expect(run.results[0]).toMatchObject({ status: "unreadable", blind: "robots-disallowed" });
    expect(s.calls.some((u) => u.includes("/blog/"))).toBe(false);

    // The sitemap readable, and every page in it off limits.
    const pagesOff = fakeSupabase(seed());
    const robots = `User-agent: *\nDisallow: /blog/\nDisallow: /hizmetler\nDisallow: /private/\nSitemap: ${S}/sitemap_index.xml\n`;
    const s2 = fakeSite(site({ [`${S}/robots.txt`]: { body: robots, type: "text/plain" } }));
    const r2 = await findDraftsLiveOnSites(client(pagesOff), { budgetMs: 60_000, fetch: s2.fetch, now: () => NIGHT_1 });
    expect(r2.results[0]).toMatchObject({ status: "unreadable", blind: "robots-disallowed", skipped: expect.objectContaining({ disallowed: 5 }) });
    expect(s2.calls.some((u) => u.includes("/blog/"))).toBe(false);
  });

  it("says so when the new pages are JavaScript shells, keeps saying it on a quiet night, and clears it when a page reads", async () => {
    const SHELL = `<!doctype html><html><head><title>Acme Ajans</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>`;
    const sb = fakeSupabase(seed());
    const shells = fakeSite(site({
      [`${S}/blog/sadakat-programi-rehberi`]: { body: SHELL },
      [`${S}/blog/standing-desk-guide`]: { body: SHELL },
      [`${S}/hizmetler`]: { body: SHELL },
    }));
    const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: shells.fetch, now: () => NIGHT_1 });
    expect(run.results[0]).toMatchObject({ status: "unreadable", blind: "javascript", shells: 3, read: 3, newlyUnreadable: true });
    expect(run.checked).toBe(0);
    expect(sb.tables.workspaces[0].found_on_site_unreadable).toBe("javascript");
    // Read once, recorded with the words it had, and not fetched again every night.
    expect(sb.tables.found_on_site_checks.every((r) => typeof r.words === "number" && (r.words as number) < 60)).toBe(true);

    // Nothing new the next night: nothing says the pages became readable.
    const quiet = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: shells.fetch, now: () => NIGHT_2 });
    expect(quiet.results[0]).toMatchObject({ status: "unreadable", blind: "javascript", read: 0 });
    expect(quiet.results[0].newlyUnreadable).toBeUndefined();

    // A new page that renders on the server clears it.
    const later = new Date("2026-09-25T10:00:00.000Z");
    const readable = fakeSite(site({
      [`${S}/post-sitemap.xml`]: { type: "application/xml", body: urlset([["/blog/yeni", "2026-09-24T12:00:00+00:00"]]) },
      [`${S}/blog/yeni`]: { body: F.UNRELATED_PAGE },
    }));
    const cleared = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: readable.fetch, now: () => later });
    expect(cleared.results[0]).toMatchObject({ status: "checked", blind: null, shells: 0 });
    expect(sb.tables.workspaces[0].found_on_site_unreadable).toBeNull();
  });

  it("leaves the last answer standing when the night ends before a sitemap is read", async () => {
    const base = seed();
    (base.workspaces[0] as Record<string, unknown>).found_on_site_unreadable = "javascript";
    const sb = fakeSupabase(base);
    let t = 0;
    const s = fakeSite(site());
    // robots.txt answers, then the clock runs out before the first sitemap.
    const slow: SafeFetch = async (url, o) => {
      const r = await s.fetch(url, o);
      if (url.endsWith("/robots.txt")) t = 1;
      return r;
    };
    const realNow = Date.now;
    const start = realNow();
    Date.now = () => (t ? start + 120_000 : start);
    try {
      const run = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: slow, now: () => NIGHT_1 });
      expect(run.results[0]).toMatchObject({ status: "skipped", detail: expect.stringContaining("out of time") });
      expect(run.results[0].blind).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
    expect(sb.tables.workspaces[0].found_on_site_unreadable).toBe("javascript");
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

  it("finds every site with a draft past PostgREST's 1,000-row page, and reads the sites in short slices", async () => {
    // 120 sites with ten drafts each: 1,200 rows, and the first 1,000 by id
    // belong to the first 100 sites. A read cut at one page leaves 20 out.
    const workspaces = Array.from({ length: 120 }, (_, w) => ({
      id: `ws-${String(w).padStart(3, "0")}`,
      domain: `site-${w}.example`,
      found_on_site_checked_at: w === 5 ? "2026-09-20T10:00:00.000Z" : null,
    }));
    const articles = Array.from({ length: 1200 }, (_, i) => ({
      id: `art-${String(i).padStart(4, "0")}`,
      workspace_id: workspaces[Math.floor(i / 10)].id,
      title: "t",
      content: {},
      status: "review",
      created_at: DRAFTED,
      found_on_site_at: null,
    }));
    const sb = fakeSupabase(seed({ workspaces, articles }));
    const from = sb.from;
    const idLists: number[] = [];
    // PostgREST as configured (supabase/config.toml max_rows = 1000): a read
    // without a range gets the first thousand rows and no error.
    const capped = ((t: string) => {
      const q = from(t) as Record<string, (...a: unknown[]) => unknown>;
      let ranged = false;
      const range = q.range;
      q.range = (...a: unknown[]) => {
        ranged = true;
        return range(...a);
      };
      if (t === "workspaces") {
        const inFn = q.in;
        q.in = (col: unknown, values: unknown) => {
          idLists.push((values as unknown[]).length);
          return inFn(col, values);
        };
      }
      const then = q.then;
      q.then = (res: unknown, rej: unknown) =>
        then((v: { data?: unknown }) => {
          const out = !ranged && Array.isArray(v?.data) ? { ...v, data: (v.data as unknown[]).slice(0, 1000) } : v;
          return (res as (x: unknown) => unknown)(out);
        }, rej);
      return q;
    }) as typeof sb.from;

    const run = await findDraftsLiveOnSites({ ...sb, from: capped } as unknown as SupabaseClient, { budgetMs: 0, now: () => NIGHT_1 });
    expect(run.considered).toBe(120);
    expect(run.results).toHaveLength(120);
    expect(Math.max(...idLists)).toBeLessThanOrEqual(100);
    // Turn order: never visited first, the one visited on the 20th last.
    expect(run.results[119].workspaceId).toBe("ws-005");
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
