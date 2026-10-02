// ---------------------------------------------------------------------------
// The found-live receipt against Postgres itself, on the local stack only
// ---------------------------------------------------------------------------
//
// on-article-live.test.ts runs the receipt on an in-memory fake that imitates
// the unique index. This runs the nightly check's real queries through
// PostgREST into a real database, which is the only thing that can show:
//
//   - migration 105's partial unique index letting exactly one of many
//     concurrent receipts for one article and page through, and one email
//   - a find's publish_log row passing the source check, and the push-only
//     readers (cron/publish's daily check, the retry button) not seeing it
//   - an article found before this shipped never firing
//   - the keyword row surviving the keywords constraints as `shipped`
//
// The mail transport is a stub (nothing leaves the process), the site is a
// fake fetch, and the check is scoped to this file's own workspace so it never
// reads or stamps another agent's rows on a shared stack. Everything it seeds
// hangs off one account and one user named for this file, and is deleted at
// the end. A stack without migration 105 fails on the first insert.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SafeFetch, SafeFetchResult } from "@/lib/public-tools/safe-fetch";
import * as F from "@/lib/found-on-site/__tests__/fixtures";

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("@/lib/email/resend", () => ({ sendTransactionalEmail }));

import { createServiceClient } from "@/lib/supabase/server";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { findDraftsLiveOnSites } from "@/lib/found-on-site/detect";
import { onArticleLive } from "../on-article-live";
import { getLastPublish, lastSuccessfulPushAt } from "../log";
import { selectTrackedKeywords } from "@/lib/seo/tracked-keywords";
import { undoFoundOnSite } from "@/lib/found-on-site/undo";

const STACK = await connectLocalStack();
const TAG = `b14-receipt-${randomUUID().slice(0, 8)}`;
const DOMAIN = `${TAG}.acme-agency.example`;
const S = `https://${DOMAIN}`;
const PAGE = `${S}/blog/sadakat-programi-rehberi`;
const OWNER = `${TAG}-owner@acme-agency.example`;

function result(url: string, status: number, body: string, type: string): SafeFetchResult {
  const buf = Buffer.from(body);
  return { requestedUrl: url, url, status, headers: { "content-type": type }, body, bodyBuffer: buf, bytes: buf.length, truncated: false, redirects: [], tlsUnverified: false, timeMs: 1 };
}

describe.skipIf(!STACK)("the found-live receipt on the local database", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId = "";
  let workspaceId = "";
  let userId = "";
  let keywordId = "";
  const drafted = new Date(Date.now() - 86_400_000).toISOString();
  const lastmod = new Date(Date.parse(drafted) + 48 * 60_000).toISOString();

  const site: Record<string, [string, string]> = {
    [`${S}/robots.txt`]: [`User-agent: *\nDisallow:\nSitemap: ${S}/sitemap.xml\n`, "text/plain"],
    [`${S}/sitemap.xml`]: [
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PAGE}</loc><lastmod>${lastmod}</lastmod></url></urlset>`,
      "application/xml",
    ],
    [PAGE]: [F.TR_COPY_PAGE, "text/html"],
  };
  const fetch: SafeFetch = async (url) => {
    const hit = site[url];
    return hit ? result(url, 200, hit[0], hit[1]) : result(url, 404, "", "text/plain");
  };
  const night = () => findDraftsLiveOnSites(db, { budgetMs: 60_000, fetch, workspaceIds: [workspaceId] });

  async function article(over: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await db
      .from("articles")
      .insert({
        workspace_id: workspaceId,
        title: F.TR_DRAFT.title,
        slug: `${TAG}-${randomUUID().slice(0, 6)}`,
        content: F.draftDoc(F.TR_DRAFT),
        status: "review",
        keyword: `${TAG} sadakat programı`,
        keyword_id: keywordId,
        created_at: drafted,
        ...over,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  beforeAll(async () => {
    db = createServiceClient();
    const { data: user, error: userErr } = await db.auth.admin.createUser({ email: OWNER, email_confirm: true });
    if (userErr || !user.user) throw new Error(`user: ${userErr?.message}`);
    userId = user.user.id;
    const { data: account, error: accountErr } = await db
      .from("accounts")
      .insert({ name: `Acme Agency (${TAG})`, slug: TAG })
      .select("id")
      .single();
    if (accountErr) throw new Error(accountErr.message);
    accountId = account.id as string;
    const { error: memberErr } = await db.from("account_members").insert({ account_id: accountId, user_id: userId, role: "owner" });
    if (memberErr) throw new Error(`member: ${memberErr.message}`);
    const { data: ws, error: wsErr } = await db
      .from("workspaces")
      .insert({ account_id: accountId, name: DOMAIN, domain: DOMAIN })
      .select("id")
      .single();
    if (wsErr) throw new Error(wsErr.message);
    workspaceId = ws.id as string;
    const { data: kw, error: kwErr } = await db
      .from("keywords")
      .insert({ workspace_id: workspaceId, term: `${TAG} sadakat programı`, status: "drafting" })
      .select("id")
      .single();
    if (kwErr) throw new Error(kwErr.message);
    keywordId = kw.id as string;
  });

  afterAll(async () => {
    if (!db) return;
    if (workspaceId) {
      await db.from("publish_log").delete().eq("workspace_id", workspaceId);
      await db.from("found_on_site_checks").delete().eq("workspace_id", workspaceId);
      await db.from("system_events").delete().eq("workspace_id", workspaceId);
      await db.from("articles").delete().eq("workspace_id", workspaceId);
      await db.from("keywords").delete().eq("workspace_id", workspaceId);
      await db.from("workspaces").delete().eq("id", workspaceId);
    }
    if (accountId) {
      await db.from("sent_emails").delete().eq("account_id", accountId);
      await db.from("account_members").delete().eq("account_id", accountId);
      await db.from("accounts").delete().eq("id", accountId);
    }
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  beforeEach(async () => {
    sendTransactionalEmail.mockReset().mockResolvedValue(undefined);
    // Each test starts from a site with no articles and no ledger.
    await db.from("publish_log").delete().eq("workspace_id", workspaceId);
    await db.from("found_on_site_checks").delete().eq("workspace_id", workspaceId);
    await db.from("articles").delete().eq("workspace_id", workspaceId);
    await db.from("sent_emails").delete().eq("account_id", accountId);
    await db.from("keywords").update({ status: "drafting" }).eq("id", keywordId);
    await db.from("keywords").delete().eq("workspace_id", workspaceId).neq("id", keywordId);
  });

  it("one night: the find, its publish_log row, the keyword shipped and one email to the owner", async () => {
    const id = await article();
    const run = await night();
    expect(run).toMatchObject({ considered: 1, found: 1 });

    const { data: logRows } = await db.from("publish_log").select("article_id, status, source, url, triggered_by").eq("workspace_id", workspaceId);
    expect(logRows).toEqual([{ article_id: id, status: "success", source: "found_on_site", url: PAGE, triggered_by: "cron" }]);
    const { data: kw } = await db.from("keywords").select("status").eq("id", keywordId).single();
    expect(kw?.status).toBe("shipped");

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0][0]).toBe(OWNER);
    expect(sendTransactionalEmail.mock.calls[0][2]).toContain(PAGE);
    const { data: ledger } = await db.from("sent_emails").select("email_type, subject_id, recipient").eq("account_id", accountId);
    expect(ledger).toEqual([{ email_type: "article_found_live", subject_id: `${id}:${PAGE}`, recipient: OWNER }]);

    // The push-only readers do not take the find for a push: cron/publish
    // still publishes today, and there is no "last attempt" to retry.
    expect(await lastSuccessfulPushAt(db, workspaceId)).toBeNull();
    expect(await getLastPublish(db, workspaceId, id)).toBeNull();

    // The second night: nothing new.
    const again = await night();
    expect(again.found).toBe(0);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it("lets one of twelve concurrent receipts for one article and page through", async () => {
    const id = await article({ status: "live", published_url: PAGE, found_on_site_at: new Date().toISOString() });
    const outs = await Promise.all(
      Array.from({ length: 12 }, () => onArticleLive(db, { id, workspaceId }, { source: "found_on_site", url: PAGE })),
    );
    expect(outs.filter((o) => o.fired)).toHaveLength(1);
    expect(outs.filter((o) => !o.fired).every((o) => o.detail === "already announced for this page")).toBe(true);
    const { count } = await db.from("publish_log").select("id", { count: "exact", head: true }).eq("article_id", id);
    expect(count).toBe(1);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it("never fires for an article found before the receipt shipped", async () => {
    await article({
      status: "live",
      published_url: PAGE,
      published_at: lastmod,
      found_on_site_at: lastmod,
      found_on_site_prior: { status: "review", published_url: null, published_at: null },
    });
    const run = await night();
    expect(run.considered).toBe(0);
    const { count } = await db.from("publish_log").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
    expect(count).toBe(0);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("tracks what it says it tracks: a mixed-case term on a row with no source is in cron/serp's selection", async () => {
    // Postgres, not the fake: `source <> 'gsc'` is NULL for a NULL source,
    // which is what dropped these rows from cron/serp before.
    const { data: typed, error: typedErr } = await db
      .from("keywords")
      .insert({ workspace_id: workspaceId, term: `${TAG} Sadakat Programı Rehberi`, status: "stored" })
      .select("id, source")
      .single();
    if (typedErr) throw new Error(typedErr.message);
    expect(typed.source).toBeNull();
    const id = await article({ keyword: `${TAG} sadakat programı rehberi`, keyword_id: null });
    const run = await night();
    expect(run.found).toBe(1);
    const { data: kw } = await db.from("keywords").select("status").eq("id", typed.id).single();
    expect(kw?.status).toBe("shipped");

    const { keywords, error } = await selectTrackedKeywords(db, workspaceId);
    expect(error).toBeUndefined();
    expect(keywords.map((k) => k.id)).toContain(typed.id);
    // The receipt's own claim matches: tracked (tonight, or once the plan starts).
    expect(run.results[0].found?.[0].receipt).toMatch(/rank tracking (nightly|after-trial)/);

    // "Not my article" puts the keyword back as well as the article.
    const undone = await undoFoundOnSite(db, id);
    expect(undone).toMatchObject({ restoredStatus: "review", restoredKeywordStatus: "stored" });
    const { data: back } = await db.from("keywords").select("status").eq("id", typed.id).single();
    expect(back?.status).toBe("stored");
  });

  it("refuses a find row without its page, and keeps every push a push", async () => {
    const id = await article();
    const { error } = await db.from("publish_log").insert({ article_id: id, workspace_id: workspaceId, status: "success", triggered_by: "cron", source: "found_on_site" });
    expect(error?.message).toContain("publish_log_found_url_check");
    const { data: push, error: pushErr } = await db
      .from("publish_log")
      .insert({ article_id: id, workspace_id: workspaceId, status: "success", triggered_by: "manual" })
      .select("source, url")
      .single();
    expect(pushErr).toBeNull();
    expect(push).toEqual({ source: "push", url: null });
    expect(await lastSuccessfulPushAt(db, workspaceId)).not.toBeNull();
  });
});
