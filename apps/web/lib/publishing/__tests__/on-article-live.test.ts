import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SafeFetch, SafeFetchResult } from "@/lib/public-tools/safe-fetch";
import { fakeSupabase, type Row, type Seed } from "@/lib/agent/__tests__/fake-supabase";
import * as F from "@/lib/found-on-site/__tests__/fixtures";

// The found-live receipt, driven through the path that calls it in
// production: the nightly check (findDraftsLiveOnSites) finding a copy on a
// fake site, against an in-memory database that enforces the one constraint
// the receipt relies on (publish_log_found_on_site_once, migration 105). The
// mail transport is a stub; nothing leaves the process, and nothing here is a
// paid call. lib/publishing/__tests__/on-article-live.db.test.ts runs the same
// path on the local Postgres.

const { sendTransactionalEmail, getQuota } = vi.hoisted(() => ({
  sendTransactionalEmail: vi.fn(),
  getQuota: vi.fn(),
}));
vi.mock("@/lib/email/resend", () => ({ sendTransactionalEmail }));
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota,
}));

import { findDraftsLiveOnSites } from "@/lib/found-on-site/detect";
import { accountLabel, describeArticleLive, onArticleLive, standingOf } from "../on-article-live";
import { renderArticleFoundLive } from "@/lib/email/lifecycle";
import { undoFoundOnSite } from "@/lib/found-on-site/undo";
import { selectTrackedKeywords, TRACK_CAP } from "@/lib/seo/tracked-keywords";
import { lastSuccessfulPushAt } from "../log";

const S = "https://acme-agency.example";
const PAGE = `${S}/blog/sadakat-programi-rehberi`;
const DRAFTED = "2026-09-22T10:00:00.000Z";
const NIGHT_1 = new Date("2026-09-23T10:00:00.000Z");
const NIGHT_2 = new Date("2026-09-24T10:00:00.000Z");

const NO_PLAN = { reason: "no-plan", trialEligible: true, limit: 7, used: 1, remaining: 6, plan: null };
const LAPSED = { ...NO_PLAN, trialEligible: false };
const PAYING = { reason: "plan", limit: 30, used: 1, remaining: 29, plan: "starter" };
const TRIALING = { ...PAYING, trial: { endsAt: "2026-09-30T00:00:00.000Z" } };

function result(url: string, status: number, body: string, type: string): SafeFetchResult {
  const buf = Buffer.from(body);
  return { requestedUrl: url, url, status, headers: { "content-type": type }, body, bodyBuffer: buf, bytes: buf.length, truncated: false, redirects: [], tlsUnverified: false, timeMs: 1 };
}

const SITE: Record<string, [string, string]> = {
  [`${S}/robots.txt`]: [`User-agent: *\nDisallow:\nSitemap: ${S}/sitemap.xml\n`, "text/plain"],
  [`${S}/sitemap.xml`]: [
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PAGE}</loc><lastmod>2026-09-22T10:48:00Z</lastmod></url></urlset>`,
    "application/xml",
  ],
  [PAGE]: [F.TR_COPY_PAGE, "text/html"],
};
const fetchSite: SafeFetch = async (url) => {
  const hit = SITE[url];
  return hit ? result(url, 200, hit[0], hit[1]) : result(url, 404, "", "text/plain");
};

function seed(over: Partial<Seed> = {}): Seed {
  return {
    workspaces: [{ id: "ws-1", domain: "acme-agency.example", account_id: "acc-1", found_on_site_checked_at: null }],
    account_members: [
      { account_id: "acc-1", user_id: "u-owner", role: "owner", workspace_ids: null },
      { account_id: "acc-1", user_id: "u-editor", role: "editor", workspace_ids: null },
    ],
    articles: [
      {
        id: "tr-draft", workspace_id: "ws-1", title: F.TR_DRAFT.title, content: F.draftDoc(F.TR_DRAFT), status: "review",
        keyword: "sadakat programı", keyword_id: "kw-1",
        created_at: DRAFTED, published_url: null, published_at: null, found_on_site_at: null, found_on_site_rejected: [],
      },
    ],
    keywords: [{ id: "kw-1", workspace_id: "ws-1", term: "sadakat programı", status: "drafting" }],
    publish_log: [],
    site_pages: [],
    found_on_site_checks: [],
    sent_emails: [],
    email_preferences: [],
    system_events: [],
    ...over,
  };
}

const EMAILS: Record<string, string> = { "u-owner": "owner@acme-agency.example", "u-editor": "editor@acme-agency.example" };

/**
 * The fake, plus the two things the receipt needs from a real stack: the
 * auth admin lookup for addresses, and the unique indexes the claims rely on
 * (publish_log_found_on_site_once; sent_emails' (type, subject, recipient)).
 */
function db(s: Seed, opts: { failLogInsert?: boolean; failMembers?: boolean } = {}) {
  const sb = fakeSupabase(s);
  const from = sb.from;
  const unique: Record<string, (a: Row, b: Row) => boolean> = {
    publish_log: (a, b) => a.source === "found_on_site" && b.source === "found_on_site" && a.article_id === b.article_id && a.url === b.url,
    sent_emails: (a, b) => a.email_type === b.email_type && a.subject_id === b.subject_id && a.recipient === b.recipient,
  };
  const wrapped = ((t: string) => {
    const q = from(t) as Record<string, unknown>;
    if (t === "account_members" && opts.failMembers) {
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "statement timeout" } }).then(res);
    }
    const insert = q.insert as (r: Row | Row[]) => unknown;
    q.insert = (r: Row | Row[]) => {
      const rows = Array.isArray(r) ? r : [r];
      if (t === "publish_log" && opts.failLogInsert) {
        return { then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: "42703", message: 'column "source" does not exist' } }).then(res) };
      }
      const same = unique[t];
      if (same && rows.some((row) => (sb.tables[t] ?? []).some((existing) => same(row, existing)))) {
        return { then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }).then(res) };
      }
      return insert(r);
    };
    return q;
  }) as typeof sb.from;
  const client = {
    ...sb,
    from: wrapped,
    auth: { ...sb.auth, admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } },
  } as unknown as SupabaseClient;
  return { sb, client };
}

const sends = () => sendTransactionalEmail.mock.calls.map((c) => ({ to: c[0] as string, subject: c[1] as string, html: c[2] as string }));
const night = (client: SupabaseClient, now: Date) => findDraftsLiveOnSites(client, { budgetMs: 60_000, fetch: fetchSite, now: () => now });

beforeEach(() => {
  sendTransactionalEmail.mockReset().mockResolvedValue(undefined);
  getQuota.mockReset().mockResolvedValue(NO_PLAN);
  delete process.env.ADMIN_EMAILS;
});
afterEach(() => {
  delete process.env.ADMIN_EMAILS;
});

describe("the found-live receipt, through the nightly check", () => {
  it("logs the find, emails the owner with the trial ask, and adds the keyword to rank tracking", async () => {
    const { sb, client } = db(seed());
    const run = await night(client, NIGHT_1);

    expect(run.found).toBe(1);
    expect(sb.tables.publish_log).toEqual([
      expect.objectContaining({ article_id: "tr-draft", workspace_id: "ws-1", status: "success", source: "found_on_site", url: PAGE }),
    ]);
    // Marked shipped: cron/serp tracks it once the account is entitled, and
    // skips it (no paid call) until then.
    expect(sb.tables.keywords.find((k) => k.id === "kw-1")?.status).toBe("shipped");

    // The owner only: the trial ask is an owner's to answer.
    expect(sends().map((m) => m.to)).toEqual(["owner@acme-agency.example"]);
    const mail = sends()[0];
    expect(mail.subject).toBe("We found your article live on acme-agency.example");
    expect(mail.html).toContain(`We found your article live at <a href="${PAGE}"`);
    expect(mail.html).toContain("Start your 7-day trial</a> to keep the week going");
    // Rank tracking has not started for an account without a plan, so the
    // email does not say it has.
    expect(mail.html).not.toContain("we check where it ranks for");
    expect(run.results[0].found?.[0].receipt).toContain("rank tracking after-trial");
    expect(run.results[0].found?.[0].receipt).toContain("account trial-eligible");
  });

  it("fires once: the second night finds nothing new and sends nothing", async () => {
    const { sb, client } = db(seed());
    await night(client, NIGHT_1);
    await night(client, NIGHT_2);
    expect(sb.tables.publish_log).toHaveLength(1);
    expect(sends()).toHaveLength(1);
  });

  it("does not fire for an article that was found before this shipped", async () => {
    const base = seed();
    Object.assign(base.articles[0], {
      status: "live", published_url: PAGE, found_on_site_at: "2026-09-22T11:00:00.000Z", found_on_site_prior: { status: "review" },
    });
    const { sb, client } = db(base);
    const run = await night(client, NIGHT_1);
    expect(run.considered).toBe(0);
    expect(sb.tables.publish_log).toHaveLength(0);
    expect(sends()).toHaveLength(0);
    expect(sb.tables.keywords[0].status).toBe("drafting");
  });

  it("says rank tracking started, and asks nothing, for an account on a plan or trialing", async () => {
    getQuota.mockResolvedValue(PAYING);
    const { client } = db(seed());
    const run = await night(client, NIGHT_1);
    const mail = sends()[0];
    expect(mail.html).toContain("From tonight we check where it ranks for <strong>sadakat programı</strong>");
    expect(mail.html).not.toContain("trial");
    expect(mail.html).not.toContain("Choose a plan");
    expect(run.results[0].found?.[0].receipt).toContain("rank tracking nightly");
  });

  it("asks for a plan, not a trial, from an account that already had one", async () => {
    getQuota.mockResolvedValue(LAPSED);
    const { client } = db(seed());
    await night(client, NIGHT_1);
    expect(sends()[0].html).toContain("Choose a plan</a> to keep the week going");
    expect(sends()[0].html).not.toContain("Start your");
  });

  it("respects an owner who switched publishing mail off, and still logs and tracks", async () => {
    const { sb, client } = db(seed({ email_preferences: [{ email: "owner@acme-agency.example", unsubscribed: ["publishing"] }] }));
    const run = await night(client, NIGHT_1);
    expect(sends()).toHaveLength(0);
    expect(sb.tables.publish_log).toHaveLength(1);
    expect(sb.tables.keywords[0].status).toBe("shipped");
    expect(run.results[0].found?.[0].receipt).toContain("already told or opted out");
  });

  it("tells the operators too when ADMIN_EMAILS is set", async () => {
    process.env.ADMIN_EMAILS = "ops@acme-ops.example";
    const { client } = db(seed());
    await night(client, NIGHT_1);
    const ops = sends().find((m) => m.to === "ops@acme-ops.example");
    expect(ops?.subject).toBe("Found live: acme-agency.example");
    expect(ops?.html).toContain(PAGE);
    expect(ops?.html).toContain("Owner email: emailed 1");
  });

  it("creates the keyword row when the article never had one, marked shipped", async () => {
    const base = seed({ keywords: [] });
    Object.assign(base.articles[0], { keyword_id: null });
    const { sb, client } = db(base);
    await night(client, NIGHT_1);
    expect(sb.tables.keywords).toEqual([
      expect.objectContaining({ workspace_id: "ws-1", term: "sadakat programı", status: "shipped", source_type: "generate" }),
    ]);
  });

  it("finds the keyword row by term when the article carries no keyword_id", async () => {
    const base = seed({ keywords: [{ id: "kw-9", workspace_id: "ws-1", term: "Sadakat Programı", status: "planned" }] });
    Object.assign(base.articles[0], { keyword_id: null });
    const { sb, client } = db(base);
    await night(client, NIGHT_1);
    expect(sb.tables.keywords).toHaveLength(1);
    expect(sb.tables.keywords[0]).toMatchObject({ id: "kw-9", status: "shipped" });
  });
});

describe("onArticleLive called directly", () => {
  it("is once per article and page: a second call sends nothing, a different page fires again", async () => {
    const { sb, client } = db(seed());
    const first = await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    const again = await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    expect(first.fired).toBe(true);
    expect(again).toEqual({ fired: false, detail: "already announced for this page" });
    expect(sends()).toHaveLength(1);

    const elsewhere = await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: `${S}/another` });
    expect(elsewhere.fired).toBe(true);
    expect(sb.tables.publish_log).toHaveLength(2);
    expect(sends()).toHaveLength(2);
  });

  it("sends nothing when the find cannot be logged, and raises it", async () => {
    const { sb, client } = db(seed(), { failLogInsert: true });
    const out = await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    expect(out.fired).toBe(false);
    expect(describeArticleLive(out)).toContain("could not log the find");
    expect(sends()).toHaveLength(0);
    expect(sb.tables.keywords[0].status).toBe("drafting");
    expect(sb.tables.system_events).toEqual([expect.objectContaining({ level: "error", source: "found_on_site.receipt" })]);
  });

  it("says nothing about the plan when the plan cannot be read", async () => {
    getQuota.mockRejectedValue(new Error("quota: could not read this account's plan"));
    const { client } = db(seed());
    const out = await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    expect(out).toMatchObject({ fired: true, standing: "unknown", tracking: "after-trial" });
    expect(sends()[0].html).not.toContain("trial");
    expect(sends()[0].html).not.toContain("we check where it ranks");
  });
});

describe("rank tracking is what cron/serp will actually select", () => {
  it("tracks a mixed-case term on a row with no source, and says so", async () => {
    // The row a person typed: its own case, no `source`. cron/serp's old
    // `.neq("source", "gsc")` dropped every such row.
    getQuota.mockResolvedValue(TRIALING);
    const base = seed({ keywords: [{ id: "kw-1", workspace_id: "ws-1", term: "Sadakat Programı Rehberi", status: "drafting", source: null, created_at: DRAFTED }] });
    Object.assign(base.articles[0], { keyword: "Sadakat Programı Rehberi" });
    const { sb, client } = db(base);
    const run = await night(client, NIGHT_1);
    expect(run.results[0].found?.[0].receipt).toContain("rank tracking nightly");
    expect(sends()[0].html).toContain("From tonight we check where it ranks for <strong>Sadakat Programı Rehberi</strong>");
    // The promise is cron/serp's own selection.
    const { keywords } = await selectTrackedKeywords(client, "ws-1");
    expect(keywords.map((k) => k.id)).toContain("kw-1");
    expect(sb.tables.keywords[0].status).toBe("shipped");
  });

  it("tracks the row it creates", async () => {
    getQuota.mockResolvedValue(TRIALING);
    const base = seed({ keywords: [] });
    Object.assign(base.articles[0], { keyword_id: null, keyword: "Sadakat Programı" });
    const { sb, client } = db(base);
    const out = await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    expect(out.tracking).toBe("nightly");
    const created = sb.tables.keywords[0];
    const { keywords } = await selectTrackedKeywords(client, "ws-1");
    expect(keywords.map((k) => k.id)).toEqual([created.id]);
  });

  it("promises nothing for a paused site, to the owner or after the trial", async () => {
    getQuota.mockResolvedValue(PAYING);
    const paused = seed();
    Object.assign(paused.workspaces[0], { status: "paused" });
    const { client } = db(paused);
    const out = await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    expect(out.tracking).toBe("not-tracked");
    expect(sends()[0].html).not.toContain("we check where it ranks");

    sendTransactionalEmail.mockClear();
    getQuota.mockResolvedValue(NO_PLAN);
    const pausedNoPlan = seed();
    Object.assign(pausedNoPlan.workspaces[0], { status: "paused" });
    const second = db(pausedNoPlan);
    await onArticleLive(second.client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    const mail = sends()[0].html;
    expect(mail).toContain("Start your 7-day trial</a> to keep the week going: the rest of this week's articles get written.");
    expect(mail).not.toContain("we start checking where this one ranks");
  });

  it("promises nothing when the term falls outside the tracked cap", async () => {
    getQuota.mockResolvedValue(PAYING);
    // TRACK_CAP newer planned rows, and the article's own row older than all of them.
    const newer = Array.from({ length: TRACK_CAP }, (_, i) => ({
      id: `kw-n${i}`, workspace_id: "ws-1", term: `acme term ${i}`, status: "planned", source: null,
      created_at: new Date(Date.parse(DRAFTED) + (i + 1) * 60_000).toISOString(),
    }));
    const base = seed({ keywords: [{ id: "kw-1", workspace_id: "ws-1", term: "sadakat programı", status: "drafting", source: null, created_at: "2026-01-01T00:00:00.000Z" }, ...newer] });
    const { client } = db(base);
    process.env.ADMIN_EMAILS = "ops@acme-ops.example";
    const out = await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    expect(out.tracking).toBe("not-tracked");
    const owner = sends().find((m) => m.to === "owner@acme-agency.example")!;
    expect(owner.html).not.toContain("we check where it ranks");
    const ops = sends().find((m) => m.to === "ops@acme-ops.example")!;
    expect(ops.html).toContain(`Rank tracking: not-tracked (not in the site&#39;s ${TRACK_CAP} tracked keywords)`);
  });
});

describe("the operators' note", () => {
  it("calls a trial a trial", async () => {
    process.env.ADMIN_EMAILS = "ops@acme-ops.example";
    getQuota.mockResolvedValue(TRIALING);
    const { client } = db(seed());
    await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    const ops = sends().find((m) => m.to === "ops@acme-ops.example")!;
    expect(ops.html).toContain("Account: trialing (starter).");
    expect(accountLabel(PAYING as never)).toBe("paying (starter)");
    expect(accountLabel(NO_PLAN as never)).toBe("no plan, trial not started");
    expect(accountLabel(null)).toMatch(/^unknown/);
  });
});

describe("a receipt that reaches nobody is raised", () => {
  it("when the owners cannot be read", async () => {
    const { sb, client } = db(seed(), { failMembers: true });
    const out = await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    expect(out.fired).toBe(true);
    expect(out.email).toContain("1 failed (could not read the account's owners: statement timeout)");
    expect(sb.tables.system_events).toEqual([
      expect.objectContaining({ level: "warn", source: "found_on_site.receipt", message: expect.stringContaining("reached nobody") }),
    ]);
  });

  it("when the provider refuses", async () => {
    sendTransactionalEmail.mockRejectedValue(new Error("provider down"));
    const { sb, client } = db(seed());
    await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    expect(sb.tables.system_events).toEqual([expect.objectContaining({ level: "warn", message: expect.stringContaining("reached nobody") })]);
  });

  it("but not when the owner opted out", async () => {
    const { sb, client } = db(seed({ email_preferences: [{ email: "owner@acme-agency.example", unsubscribed: ["publishing"] }] }));
    await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: PAGE });
    expect(sb.tables.system_events).toEqual([]);
  });
});

describe("Not my article puts the keyword back too", () => {
  it("to the status it had", async () => {
    const { sb, client } = db(seed());
    await night(client, NIGHT_1);
    expect(sb.tables.keywords[0].status).toBe("shipped");
    expect(sb.tables.articles[0].found_on_site_prior).toMatchObject({ status: "review", keyword: { id: "kw-1", status: "drafting" } });
    const r = await undoFoundOnSite(client, "tr-draft");
    expect(r).toMatchObject({ restoredStatus: "review", restoredKeywordStatus: "drafting" });
    expect(sb.tables.keywords[0].status).toBe("drafting");
    expect(sb.tables.articles[0].status).toBe("review");
  });

  it("to planned when the receipt created the row", async () => {
    const base = seed({ keywords: [] });
    Object.assign(base.articles[0], { keyword_id: null });
    const { sb, client } = db(base);
    await night(client, NIGHT_1);
    await undoFoundOnSite(client, "tr-draft");
    expect(sb.tables.keywords).toEqual([expect.objectContaining({ term: "sadakat programı", status: "planned" })]);
  });

  it("keeps the first receipt's answer when a second page fires for the same find", async () => {
    const { sb, client } = db(seed());
    await night(client, NIGHT_1);
    await onArticleLive(client, { id: "tr-draft", workspaceId: "ws-1" }, { source: "found_on_site", url: `${S}/another` });
    expect(sb.tables.articles[0].found_on_site_prior).toMatchObject({ keyword: { id: "kw-1", status: "drafting" } });
    await undoFoundOnSite(client, "tr-draft");
    expect(sb.tables.keywords[0].status).toBe("drafting");
  });

  it("not when someone changed the keyword since", async () => {
    const { sb, client } = db(seed());
    await night(client, NIGHT_1);
    sb.tables.keywords[0].status = "stored";
    const r = await undoFoundOnSite(client, "tr-draft");
    expect(r.restoredKeywordStatus).toBeUndefined();
    expect(sb.tables.keywords[0].status).toBe("stored");
  });
});

describe("cron/publish's daily check", () => {
  it("throws on an unreadable log instead of answering 'never published'", async () => {
    const sb = fakeSupabase({ publish_log: [] });
    const from = sb.from;
    const client = {
      ...sb,
      from: (t: string) => {
        const q = from(t) as Record<string, unknown>;
        q.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { code: "42703", message: 'column publish_log.source does not exist' } }).then(res);
        return q;
      },
    } as unknown as SupabaseClient;
    await expect(lastSuccessfulPushAt(client, "ws-1")).rejects.toThrow(/could not read the publish log/);
  });
});

describe("standingOf and the email", () => {
  it("reads every quota reason", () => {
    expect(standingOf(null)).toBe("unknown");
    expect(standingOf({ reason: "plan" })).toBe("paying");
    expect(standingOf({ reason: "operator" })).toBe("paying");
    expect(standingOf({ reason: "self-host" })).toBe("paying");
    expect(standingOf({ reason: "no-plan", trialEligible: true })).toBe("trial-eligible");
    expect(standingOf({ reason: "no-plan", trialEligible: false })).toBe("lapsed");
  });

  it("escapes what the site and the page put in it", () => {
    const out = renderArticleFoundLive({
      domain: "acme-agency.example",
      title: `<script>x</script>`,
      articleId: "a-1",
      url: `${S}/a?b="c"`,
      keyword: null,
      standing: "paying",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&quot;c&quot;");
  });
});
