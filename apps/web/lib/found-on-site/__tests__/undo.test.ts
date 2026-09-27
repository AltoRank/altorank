import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SafeFetch, SafeFetchResult } from "@/lib/public-tools/safe-fetch";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import { findDraftsLiveOnSites } from "../detect";
import { NothingToUndoError, undoFoundOnSite } from "../undo";
import * as F from "./fixtures";

const S = "https://acme-agency.example";
const client = (sb: ReturnType<typeof fakeSupabase>) => sb as unknown as SupabaseClient;

const found = {
  id: "a1",
  workspace_id: "ws-1",
  status: "live",
  published_url: `${S}/blog/kopya`,
  published_at: "2026-09-22T10:48:00.000Z",
  found_on_site_at: "2026-09-23T10:00:00.000Z",
  found_on_site_evidence: { containment: 0.66, title: 0.57, rule: "text" },
  found_on_site_prior: { status: "approved", published_url: `${S}/?p=123&preview=true`, published_at: "2026-09-22T11:00:00.000Z" },
  found_on_site_rejected: [],
};

describe("undoFoundOnSite", () => {
  it("puts the article back exactly as it was and remembers the page", async () => {
    const sb = fakeSupabase({ articles: [found] });
    const r = await undoFoundOnSite(client(sb), "a1");
    expect(r).toEqual({ articleId: "a1", restoredStatus: "approved", rejectedUrl: `${S}/blog/kopya` });
    expect(sb.tables.articles[0]).toMatchObject({
      status: "approved",
      // An approved article held as a draft on a CMS gets its own URL back.
      published_url: `${S}/?p=123&preview=true`,
      published_at: "2026-09-22T11:00:00.000Z",
      found_on_site_at: null,
      found_on_site_evidence: null,
      found_on_site_prior: null,
      found_on_site_rejected: [`${S}/blog/kopya`],
    });
  });

  it("refuses an article that is live because we published it", async () => {
    const sb = fakeSupabase({ articles: [{ ...found, found_on_site_at: null }] });
    await expect(undoFoundOnSite(client(sb), "a1")).rejects.toBeInstanceOf(NothingToUndoError);
    expect(sb.writes).toHaveLength(0);
  });

  it("refuses to guess a status when the one before the find was not recorded", async () => {
    const sb = fakeSupabase({ articles: [{ ...found, found_on_site_prior: null }] });
    await expect(undoFoundOnSite(client(sb), "a1")).rejects.toThrow(/was not recorded/);
    const sb2 = fakeSupabase({ articles: [{ ...found, found_on_site_prior: { status: "live" } }] });
    await expect(undoFoundOnSite(client(sb2), "a1")).rejects.toThrow(/was not recorded/);
  });

  it("does nothing on a second click", async () => {
    const sb = fakeSupabase({ articles: [found] });
    await undoFoundOnSite(client(sb), "a1");
    await expect(undoFoundOnSite(client(sb), "a1")).rejects.toBeInstanceOf(NothingToUndoError);
    expect(sb.tables.articles[0].status).toBe("approved");
  });

  it("round trip: found, undone, and not found again when the page changes the next day", async () => {
    const drafted = "2026-09-22T10:00:00.000Z";
    const sb = fakeSupabase({
      workspaces: [{ id: "ws-1", domain: "acme-agency.example", found_on_site_checked_at: null }],
      articles: [
        {
          id: "tr", workspace_id: "ws-1", title: F.TR_DRAFT.title, content: F.draftDoc(F.TR_DRAFT), status: "review",
          created_at: drafted, published_url: null, published_at: null, found_on_site_at: null, found_on_site_rejected: [],
        },
      ],
      site_pages: [],
      found_on_site_checks: [],
    });
    const siteOn = (lastmod: string): SafeFetch => async (url) => {
      const files: Record<string, [string, string]> = {
        [`${S}/robots.txt`]: ["User-agent: *\nDisallow:\n", "text/plain"],
        [`${S}/sitemap.xml`]: [
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${S}/blog/kopya</loc><lastmod>${lastmod}</lastmod></url></urlset>`,
          "application/xml",
        ],
        [`${S}/blog/kopya`]: [F.TR_COPY_PAGE, "text/html"],
      };
      const hit = files[url];
      const body = hit?.[0] ?? "";
      const buf = Buffer.from(body);
      const res: SafeFetchResult = {
        requestedUrl: url, url, status: hit ? 200 : 404, headers: { "content-type": hit?.[1] ?? "text/plain" }, body,
        bodyBuffer: buf, bytes: buf.length, truncated: false, redirects: [], tlsUnverified: false, timeMs: 1,
      };
      return res;
    };

    const night1 = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: siteOn("2026-09-22T10:48:00Z"), now: () => new Date("2026-09-23T10:00:00Z") });
    expect(night1.found).toBe(1);

    await undoFoundOnSite(client(sb), "tr");
    expect(sb.tables.articles[0]).toMatchObject({ status: "review", published_url: null, found_on_site_at: null });

    // The page is edited again (lastmod moves), so it is read again - and
    // still not matched to the article the person said it is not.
    const night2 = await findDraftsLiveOnSites(client(sb), { budgetMs: 60_000, fetch: siteOn("2026-09-24T08:00:00Z"), now: () => new Date("2026-09-24T10:00:00Z") });
    expect(night2.found).toBe(0);
    expect(sb.tables.articles[0].status).toBe("review");
  });
});
