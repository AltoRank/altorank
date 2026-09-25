/**
 * The body lock as the dashboard's reads apply it.
 *
 * Migration 097 refuses the body columns to every client token, so the reads
 * ask the person's own client for ids (RLS decides which rows), read the rows
 * whole on the server, and withhold the text from every row whose account is
 * gated for this person. The fake below holds the same privileges: its
 * cookie client refuses a select that names the text, and only the service
 * client answers one. These tests hold the reads to that: stripped for a
 * gated account, untouched for a paying one, decided per account when a
 * person belongs to both, and never asked of the person's client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Quota } from "@/lib/billing/quota";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";

type Row = Record<string, unknown>;

let user: { id: string; email: string } | null;
let workspaces: Row[];
let articles: Row[];
let quotas: Record<string, Quota>;
let simulation: { gate?: boolean } | null;
let workspaceError: { message: string } | null;
/** Every select list the person's own client was asked for, on articles. */
let cookieSelects: string[];

const BODY = /\*|\b(content|meta_description|fact_checks|link_checks|seo_checks|aeo_checks)\b/;

/**
 * Enough of PostgREST for these reads: eq, in, order, limit, single. `role`
 * is whose token it holds: the person's (`authenticated`), or the service
 * role. The person sees the workspaces they belong to - all of `workspaces`
 * here - and the articles in them.
 */
function client(role: "authenticated" | "service" = "authenticated") {
  const from = (table: string) => {
    let rows = (table === "workspaces" ? workspaces : articles).slice();
    if (role === "authenticated" && table === "articles") {
      const mine = new Set(workspaces.map((w) => w.id));
      rows = rows.filter((r) => mine.has(r.workspace_id));
    }
    let denied = false;
    const answer = () => ({
      data: denied ? null : rows,
      error: denied
        ? { message: "permission denied for table articles" }
        : table === "workspaces"
          ? workspaceError
          : null,
    });
    const q = {
      select: (cols: string = "*") => {
        if (table === "articles" && role === "authenticated") {
          cookieSelects.push(cols);
          if (BODY.test(cols)) denied = true;
        }
        return q;
      },
      eq: (col: string, v: unknown) => ((rows = rows.filter((r) => r[col] === v)), q),
      in: (col: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[col]))), q),
      order: () => q,
      limit: () => q,
      single: async () => {
        const a = answer();
        if (a.error) return { data: null, error: a.error };
        return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "none" } };
      },
      maybeSingle: async () => {
        const a = answer();
        return { data: a.error ? null : (rows[0] ?? null), error: a.error };
      },
      then: (ok: (v: unknown) => unknown) => Promise.resolve(answer()).then(ok),
    };
    return q;
  };
  return { from, auth: { getUser: async () => ({ data: { user } }) } };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => client("authenticated"),
  createServiceClient: () => client("service"),
}));
vi.mock("@/lib/queries/quota", () => ({ getRequestQuota: async (accountId: string) => quotas[accountId] }));
vi.mock("@/lib/billing/quota", () => ({ getQuota: async (_s: unknown, accountId: string) => quotas[accountId] }));
vi.mock("@/lib/dev/simulation", () => ({ getSimulation: async () => simulation }));

const GATED: Quota = { limit: 7, used: 1, remaining: 6, reason: "no-plan", plan: null, trialEligible: true };
const PAYING: Quota = { limit: 100, used: 1, remaining: 99, reason: "plan", plan: "starter" };
/** Had its trial and let it lapse: not asked for a card again, so not gated. */
const TRIALED: Quota = { limit: 7, used: 7, remaining: 0, reason: "no-plan", plan: null, trialEligible: false };

const SECRET = "Bu cümle deneme süresi başlamadan hiçbir yerde görünmemeli.";
const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: SECRET }] }] };

function article(id: string, workspace_id: string): Row {
  return {
    id,
    workspace_id,
    title: `Başlık ${id}`,
    keyword: "ajans",
    status: "review",
    word_count: 9,
    content: body,
    meta_description: SECRET,
    fact_checks: { claims: [{ sentence: SECRET }] },
    link_checks: [{ url: "https://source.example/a" }],
    seo_checks: [{ name: "keyword", note: SECRET }],
    aeo_checks: [{ note: SECRET }],
    seo_score: 70,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  user = { id: "u1", email: "owner@acme-agency.example" };
  workspaces = [
    { id: "ws-gated", account_id: "acc-gated" },
    { id: "ws-paying", account_id: "acc-paying" },
  ];
  articles = [article("a1", "ws-gated"), article("a2", "ws-paying")];
  quotas = { "acc-gated": GATED, "acc-paying": PAYING };
  simulation = null;
  workspaceError = null;
  cookieSelects = [];
});

describe("withoutBody", () => {
  it("nulls every column that carries or quotes the text, and nothing else", async () => {
    const { withoutBody, ARTICLE_BODY_COLUMNS } = await import("@/lib/billing/body-lock");
    const out = withoutBody(article("a1", "ws-gated"));
    for (const c of ARTICLE_BODY_COLUMNS) expect(out[c]).toBeNull();
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out).toMatchObject({ id: "a1", title: "Başlık a1", keyword: "ajans", word_count: 9, seo_score: 70 });
  });

  it("does not add columns a select did not ask for", async () => {
    const { withoutBody } = await import("@/lib/billing/body-lock");
    expect(withoutBody({ id: "x", workspace_id: "w" })).toEqual({ id: "x", workspace_id: "w" });
  });
});

describe("the dashboard's article reads", () => {
  it("getArticle strips the text for an account before its trial", async () => {
    const { getArticle } = await import("@/lib/queries/articles");
    const a = await getArticle("a1");
    expect(a?.content).toBeNull();
    expect(JSON.stringify(a)).not.toContain(SECRET);
    expect(a?.title).toBe("Başlık a1");
  });

  it("getArticle leaves a paying account's article alone", async () => {
    const { getArticle } = await import("@/lib/queries/articles");
    const a = await getArticle("a2");
    expect(a?.content).toEqual(body);
    expect(a?.meta_description).toBe(SECRET);
  });

  it("getArticles decides per account for a person in both", async () => {
    const { getArticles } = await import("@/lib/queries/articles");
    const rows = await getArticles();
    expect(rows.find((r) => r.id === "a1")?.content).toBeNull();
    expect(rows.find((r) => r.id === "a2")?.content).toEqual(body);
  });

  it("getRecentArticles strips too", async () => {
    const { getRecentArticles } = await import("@/lib/queries/articles");
    const rows = await getRecentArticles(6, "ws-gated");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("an account that already had its trial is not gated again", async () => {
    quotas["acc-gated"] = TRIALED;
    const { getArticle } = await import("@/lib/queries/articles");
    expect((await getArticle("a1"))?.content).toEqual(body);
  });

  it("the kill switch opens the text with the dashboard", async () => {
    vi.stubEnv("TRIAL_GATE_DISABLED", "1");
    const { getArticle } = await import("@/lib/queries/articles");
    expect((await getArticle("a1"))?.content).toEqual(body);
  });

  it("a bypassed address reads it, as it reaches the dashboard", async () => {
    vi.stubEnv("TRIAL_GATE_BYPASS_EMAILS", "owner@acme-agency.example");
    user = { id: "u1", email: "owner+test@acme-agency.example" };
    const { getArticle } = await import("@/lib/queries/articles");
    expect((await getArticle("a1"))?.content).toEqual(body);
  });

  it("the dev simulation locks a paying account's text, as it redirects it", async () => {
    simulation = { gate: true };
    const { getArticle } = await import("@/lib/queries/articles");
    expect((await getArticle("a2"))?.content).toBeNull();
  });

  it("never asks the person's own client for the text", async () => {
    const { getArticle, getArticles, getRecentArticles } = await import("@/lib/queries/articles");
    await getArticle("a2");
    await getArticles();
    await getRecentArticles(6);
    expect(cookieSelects.length).toBeGreaterThan(0);
    expect(cookieSelects.filter((c) => BODY.test(c))).toEqual([]);
  });

  it("keeps the order the person's client asked for", async () => {
    articles = [article("a3", "ws-paying"), article("a1", "ws-gated"), article("a2", "ws-paying")];
    const { getArticles } = await import("@/lib/queries/articles");
    expect((await getArticles()).map((r) => r.id)).toEqual(["a3", "a1", "a2"]);
  });

  it("does not widen what the person's client returned", async () => {
    // A site the person is not a member of: RLS hides its rows from their
    // client, and the server read is only ever of ids that client returned.
    articles.push(article("a9", "ws-other"));
    const { getArticles } = await import("@/lib/queries/articles");
    expect((await getArticles()).map((r) => r.id)).not.toContain("a9");
  });

  it("with no session nothing readable leaves", async () => {
    user = null;
    const { articlesForSession } = await import("@/lib/billing/body-lock");
    const rows = await articlesForSession([{ id: "a2" }]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("a row whose site cannot be placed is treated as locked", async () => {
    // The site is not one the person's client can read, so its account is unknown.
    articles.push(article("a9", "ws-unknown"));
    const { articlesForSession } = await import("@/lib/billing/body-lock");
    const rows = await articlesForSession<Row>([{ id: "a9" }]);
    expect(rows[0].content).toBeNull();
  });

  it("a failed read of the rows' sites refuses rather than shows", async () => {
    workspaceError = { message: "timeout" };
    const { articlesForSession } = await import("@/lib/billing/body-lock");
    await expect(articlesForSession([{ id: "a2" }])).rejects.toThrow(/could not read/);
  });
});

describe("articleBodyForSession", () => {
  it("refuses an account before its trial, with the one sentence", async () => {
    const { articleBodyForSession } = await import("@/lib/billing/body-lock");
    await expect(articleBodyForSession("a1")).rejects.toThrow(BODY_LOCKED_MESSAGE);
  });

  it("hands a paying account the columns asked for", async () => {
    const { articleBodyForSession } = await import("@/lib/billing/body-lock");
    const row = await articleBodyForSession<Row>("a2", "content, research");
    expect(row.content).toEqual(body);
    expect(cookieSelects.filter((c) => BODY.test(c))).toEqual([]);
  });

  it("is not found for an article the person's client cannot see", async () => {
    articles.push(article("a9", "ws-other"));
    const { articleBodyForSession } = await import("@/lib/billing/body-lock");
    await expect(articleBodyForSession("a9")).rejects.toThrow("Article not found");
  });
});

describe("readVisibleArticle", () => {
  it("reads the row whole on the server once the caller's client can see it", async () => {
    const { readVisibleArticle } = await import("@/lib/articles/body-read");
    const row = await readVisibleArticle<Row>(client("authenticated") as never, "a2");
    expect(row?.content).toEqual(body);
    expect(cookieSelects).toEqual(["id"]);
  });

  it("is null when the caller's client cannot see it, and reads nothing", async () => {
    articles.push(article("a9", "ws-other"));
    const { readVisibleArticle } = await import("@/lib/articles/body-read");
    expect(await readVisibleArticle(client("authenticated") as never, "a9")).toBeNull();
  });
});

describe("sessionBodyLockedForWorkspace", () => {
  it("is true for a gated account's site and false for a paying one's", async () => {
    const { sessionBodyLockedForWorkspace } = await import("@/lib/billing/body-lock");
    expect(await sessionBodyLockedForWorkspace("ws-gated")).toBe(true);
    expect(await sessionBodyLockedForWorkspace("ws-paying")).toBe(false);
  });

  it("is true for a site the caller cannot see", async () => {
    const { sessionBodyLockedForWorkspace } = await import("@/lib/billing/body-lock");
    expect(await sessionBodyLockedForWorkspace("ws-nobody")).toBe(true);
  });
});

describe("accountTrialGate", () => {
  it("asks the same question with the caller's own client", async () => {
    const { accountTrialGate } = await import("@/lib/billing/body-lock");
    expect(await accountTrialGate(client() as never, "acc-gated", null)).toBe("gated");
    expect(await accountTrialGate(client() as never, "acc-paying", null)).toBe("open");
  });
});
