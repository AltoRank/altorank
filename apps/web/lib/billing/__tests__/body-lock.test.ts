/**
 * The body lock as the dashboard's reads apply it.
 *
 * The dashboard layout redirects an account before its trial to /onboarding,
 * but a layout is not re-rendered on client navigation, so the article reads
 * the pages make (lib/queries/articles.ts) strip the text themselves. These
 * tests hold the reads to that: stripped for a gated account, untouched for a
 * paying one, decided per account when a person belongs to both.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Quota } from "@/lib/billing/quota";

type Row = Record<string, unknown>;

let user: { id: string; email: string } | null;
let workspaces: Row[];
let articles: Row[];
let quotas: Record<string, Quota>;
let simulation: { gate?: boolean } | null;
let workspaceError: { message: string } | null;

/** Enough of PostgREST for these reads: eq, in, order, limit, single. */
function client() {
  const from = (table: string) => {
    let rows = (table === "workspaces" ? workspaces : articles).slice();
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => ((rows = rows.filter((r) => r[col] === v)), q),
      in: (col: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[col]))), q),
      order: () => q,
      limit: () => q,
      single: async () => (rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "none" } }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: table === "workspaces" ? workspaceError : null }),
      then: (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: table === "workspaces" ? workspaceError : null }).then(ok),
    };
    return q;
  };
  return { from, auth: { getUser: async () => ({ data: { user } }) } };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
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

  it("with no session nothing readable leaves", async () => {
    user = null;
    const { lockArticleBodies } = await import("@/lib/billing/body-lock");
    const rows = await lockArticleBodies([article("a2", "ws-paying")]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("a row whose site cannot be placed is treated as locked", async () => {
    const { lockArticleBodies } = await import("@/lib/billing/body-lock");
    const rows = await lockArticleBodies([article("a9", "ws-unknown")]);
    expect(rows[0].content).toBeNull();
  });

  it("a failed read of the rows' sites refuses rather than shows", async () => {
    workspaceError = { message: "timeout" };
    const { lockArticleBodies } = await import("@/lib/billing/body-lock");
    await expect(lockArticleBodies([article("a2", "ws-paying")])).rejects.toThrow(/could not read/);
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
