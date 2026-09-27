import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SafeFetch, SafeFetchResult } from "@/lib/public-tools/safe-fetch";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import * as F from "@/lib/found-on-site/__tests__/fixtures";

/**
 * cron/site-pages hosts the found-on-site check (lib/found-on-site/detect.ts)
 * ahead of its crawl. This drives the route itself, with the SSRF-guarded
 * fetch replaced by a fake site and the crawl stubbed: the check runs for
 * real against an in-memory database, the crawl still gets its turn and a
 * bounded share of the time, and a second night records nothing new.
 */

const S = "https://acme-agency.example";
const { fakeFetch, syncSitePages } = vi.hoisted(() => ({ fakeFetch: { current: null as SafeFetch | null }, syncSitePages: vi.fn() }));
let sb: FakeSupabase;

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    ...sb,
    // The crawl's own queue query uses `.or()`, which the fake does not
    // model; it is a pass-through here, and the seed decides what it returns.
    from: (t: string) => {
      const q = sb.from(t) as Record<string, unknown>;
      q.or ??= () => q;
      return q;
    },
  }),
}));
vi.mock("@/lib/public-tools/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/public-tools/safe-fetch")>()),
  safeFetch: (url: string, opts?: unknown) => fakeFetch.current!(url, opts as never),
}));
vi.mock("@/lib/billing/quota", () => ({ getQuota: async () => ({ reason: "plan" }), entitledToScheduledWork: () => true }));
vi.mock("@/lib/seo/site-crawl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/site-crawl")>()),
  syncSitePages: (...a: unknown[]) => syncSitePages(...a),
}));
vi.mock("@/lib/linking/detect", () => ({ detectLinks: async () => ({ found: 0, added: 0 }) }));

import { GET } from "../site-pages/route";

const req = () => new Request("http://localhost/api/cron/site-pages", { headers: { "x-cron-secret": "s" } });

function page(url: string, status: number, body: string, type: string): SafeFetchResult {
  const buf = Buffer.from(body);
  return { requestedUrl: url, url, status, headers: { "content-type": type }, body, bodyBuffer: buf, bytes: buf.length, truncated: false, redirects: [], tlsUnverified: false, timeMs: 1 };
}

const calls: string[] = [];
const site: Record<string, [string, string]> = {
  [`${S}/robots.txt`]: [`User-agent: *\nDisallow:\nSitemap: ${S}/sitemap.xml\n`, "text/plain"],
  [`${S}/sitemap.xml`]: [
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${S}/blog/sadakat</loc><lastmod>2026-09-22T10:48:00Z</lastmod></url></urlset>`,
    "application/xml",
  ],
  [`${S}/blog/sadakat`]: [F.TR_COPY_PAGE, "text/html"],
};

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  calls.length = 0;
  syncSitePages.mockReset().mockResolvedValue({ discovered: 0, fetched: 0, failed: 0, skipped: 0, pages: [], tech: null, disallowed: 0, truncated: false, robotsBlocked: false });
  fakeFetch.current = async (url) => {
    calls.push(url);
    const hit = site[url];
    return hit ? page(url, 200, hit[0], hit[1]) : page(url, 404, "", "text/plain");
  };
  // Drafted yesterday: inside the thirty-day window whatever today is.
  const drafted = new Date(Date.now() - 86_400_000).toISOString();
  site[`${S}/sitemap.xml`][0] = site[`${S}/sitemap.xml`][0].replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${new Date(Date.parse(drafted) + 48 * 60_000).toISOString()}</lastmod>`);
  sb = fakeSupabase({
    workspaces: [
      { id: "ws-1", domain: "acme-agency.example", account_id: "acc-1", status: "on", first_analysed_at: "2026-09-01T00:00:00Z", last_pages_crawl_at: null, found_on_site_checked_at: null },
    ],
    articles: [
      { id: "tr-draft", workspace_id: "ws-1", title: F.TR_DRAFT.title, content: F.draftDoc(F.TR_DRAFT), status: "review", created_at: drafted, published_url: null, published_at: null, found_on_site_at: null, found_on_site_rejected: [] },
      { id: "en-draft", workspace_id: "ws-1", title: F.EN_DRAFT.title, content: F.draftDoc(F.EN_DRAFT), status: "review", created_at: drafted, published_url: null, published_at: null, found_on_site_at: null, found_on_site_rejected: [] },
    ],
    site_pages: [],
    found_on_site_checks: [],
    system_events: [],
  });
});

describe("cron/site-pages with the found-on-site check", () => {
  it("finds the copy, reports it at the top level, and still runs the crawl with a bounded budget", async () => {
    const body = await (await GET(req())).json();
    expect(body.found_on_site).toBe(1);
    expect(body.found_on_site_sites).toBe(1);
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ job: "found-on-site", workspaceId: "ws-1", status: "checked", found: [expect.objectContaining({ articleId: "tr-draft", url: `${S}/blog/sadakat` })] }),
      ]),
    );
    expect(sb.tables.articles.find((a) => a.id === "tr-draft")).toMatchObject({ status: "live", published_url: `${S}/blog/sadakat` });

    // The crawl ran after it, inside what is left of the 300 seconds.
    expect(syncSitePages).toHaveBeenCalledTimes(1);
    const opts = syncSitePages.mock.calls[0][3] as { budgetMs: number };
    expect(opts.budgetMs).toBeGreaterThanOrEqual(30_000);
    expect(opts.budgetMs).toBeLessThanOrEqual(240_000);
  });

  it("records nothing new on the second night", async () => {
    await GET(req());
    const writesAfterFirst = sb.writes.filter((w) => w.table === "articles").length;
    calls.length = 0;

    const body = await (await GET(req())).json();
    expect(body.found_on_site).toBe(0);
    expect(calls).not.toContain(`${S}/blog/sadakat`);
    expect(sb.writes.filter((w) => w.table === "articles")).toHaveLength(writesAfterFirst);
    expect(sb.tables.found_on_site_checks).toHaveLength(1);
  });

  it("raises a site it cannot see as a warning once, the night it starts, and never counts it as checked", async () => {
    delete site[`${S}/sitemap.xml`];
    site[`${S}/robots.txt`] = ["User-agent: *\nDisallow:\n", "text/plain"];
    try {
      const body = await (await GET(req())).json();
      expect(body).toMatchObject({ found_on_site: 0, found_on_site_sites: 0, found_on_site_unreadable: 1 });
      const warned = () => sb.tables.system_events.filter((e) => e.source === "found_on_site.check");
      expect(warned()).toHaveLength(1);
      expect(warned()[0]).toMatchObject({ level: "warn", context: expect.objectContaining({ reason: "no-sitemap" }) });
      expect(String(warned()[0].message)).toContain("no sitemap");

      // Still unreadable the next night, and not news any more.
      await GET(req());
      expect(warned()).toHaveLength(1);
    } finally {
      site[`${S}/robots.txt`] = [`User-agent: *\nDisallow:\nSitemap: ${S}/sitemap.xml\n`, "text/plain"];
      site[`${S}/sitemap.xml`] = [
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${S}/blog/sadakat</loc><lastmod>2026-09-22T10:48:00Z</lastmod></url></urlset>`,
        "application/xml",
      ];
    }
  });

  it("reports the check failing outright as a failed result, and the crawl still runs", async () => {
    const from = sb.from;
    sb.from = ((t: string) => {
      if (t === "articles") {
        const q = from(t) as Record<string, unknown>;
        q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "relation does not exist" } }).then(resolve);
        return q;
      }
      return from(t);
    }) as typeof sb.from;
    const body = await (await GET(req())).json();
    expect(body.found_on_site_error).toContain("relation does not exist");
    expect(body.results).toEqual(expect.arrayContaining([expect.objectContaining({ job: "found-on-site", status: "error" })]));
    expect(syncSitePages).toHaveBeenCalledTimes(1);
  });
});
