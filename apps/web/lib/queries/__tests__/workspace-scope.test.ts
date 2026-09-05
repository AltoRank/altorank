/**
 * Every workspace-scoped read, asked the same question: given two sites, does
 * it return only the one it was asked about?
 *
 * On 2026-09-03 seven surfaces answered no. None of them threw, none leaked
 * across accounts, and none were visible on an account with a single site -
 * RLS quietly supplied *agency* scope where the page meant *workspace* scope,
 * so the sidebar read "4" beside a list of 2. See
 * `lib/queries/__tests__/scope-fixture.ts` for why the fixture always holds
 * two workspaces.
 *
 * A new workspace-scoped query belongs in the table below. The cost is one
 * line; the bug it prevents shipped to production twice in one day.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  WORKSPACE_A,
  WORKSPACE_B,
  twoWorkspaces,
  makeClient,
  leaksOtherWorkspace,
  type Seed,
} from "./scope-fixture";

let seed: Seed = {};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => makeClient(seed),
}));

/** Three rows per workspace for every table these queries touch. */
function freshSeed(): Seed {
  const tables = [
    "articles",
    "keywords",
    "backlinks",
    "reports",
    "geo_prompts",
    "calendar_entries",
    "publish_log",
    "workspace_integrations",
    "voice_profiles",
    "analytics_metrics",
  ];
  const seeded: Seed = {};
  for (const t of tables) {
    seeded[t] = twoWorkspaces(3, (workspace_id, i) => ({
      id: `${t}-${workspace_id.slice(0, 4)}-${i}`,
      workspace_id,
      // Enough shape for the queries that map over their results.
      title: `${t} ${i}`,
      term: `term ${i}`,
      status: "draft",
      integration_id: "gsc",
      metric_date: "2026-09-01",
      clicks: 1,
      impressions: 10,
      // Search Console rows carry the query; keyword rows carry its price.
      // Both workspaces share the terms, which is the point: the value
      // query must price A's clicks with A's research only.
      source: "gsc",
      query: `term ${i}`,
      article_id: "article-shared",
      cpc: 2,
      config: { type: "wordpress" },
    }));
  }
  return seeded;
}

beforeEach(() => {
  seed = freshSeed();
});

/**
 * The queries under test. Each entry calls the real function with WORKSPACE_A
 * and hands back the rows it produced.
 */
const scopedReads: { name: string; run: () => Promise<unknown[]> }[] = [
  {
    name: "getArticles",
    run: async () => (await import("../articles")).getArticles(WORKSPACE_A),
  },
  {
    name: "getRecentArticles",
    run: async () => (await import("../articles")).getRecentArticles(6, WORKSPACE_A),
  },
  {
    name: "getKeywords",
    run: async () => (await import("../keywords")).getKeywords(WORKSPACE_A),
  },
  {
    name: "getPlannerKeywords",
    // Ids from both workspaces on purpose: the id list must not widen the read.
    run: async () =>
      (await import("../keywords")).getPlannerKeywords(WORKSPACE_A, ["keywords-aaaa-0", "keywords-bbbb-0"]),
  },
  {
    name: "getBacklinks",
    run: async () => (await import("../backlinks")).getBacklinks(WORKSPACE_A),
  },
  {
    name: "getReports",
    run: async () => (await import("../reports")).getReports(WORKSPACE_A),
  },
  {
    name: "getGeoPrompts",
    run: async () => (await import("../geo")).getGeoPrompts(WORKSPACE_A),
  },
];

describe("workspace-scoped reads return one site's rows", () => {
  for (const { name, run } of scopedReads) {
    it(`${name} returns only the workspace it was given`, async () => {
      const rows = (await run()) as Record<string, unknown>[];

      // Non-empty matters: a query that returns nothing passes a "no foreign
      // rows" check trivially, which would make this whole file decorative.
      expect(rows.length).toBeGreaterThan(0);
      expect(leaksOtherWorkspace(rows, WORKSPACE_A)).toBe(false);
      expect(rows.every((r) => r.workspace_id === WORKSPACE_A)).toBe(true);
    });
  }
});

describe("scoping is symmetric", () => {
  // Without this, a fixture that always handed back the first workspace would
  // pass every test above. Asking for B has to give B.
  it("returns the second workspace when that is the one asked for", async () => {
    const { getArticles } = await import("../articles");
    const rows = await getArticles(WORKSPACE_B);

    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.workspace_id === WORKSPACE_B)).toBe(true);
    expect(leaksOtherWorkspace(rows, WORKSPACE_B)).toBe(false);
  });
});

describe("the fixture can tell scoped from unscoped", () => {
  // Guard on the guard. If the fake ignored .eq("workspace_id"), every test
  // above would pass while proving nothing - so prove the fake discriminates.
  it("returns both workspaces when no workspace filter is applied", async () => {
    const client = makeClient(seed);
    const { data } = await client.from("articles").select("*");
    if (!data) throw new Error("fixture returned no rows");
    expect(data.length).toBe(6);
    expect(leaksOtherWorkspace(data, WORKSPACE_A)).toBe(true);
  });

  it("returns one workspace when the filter is applied", async () => {
    const client = makeClient(seed);
    const { data } = await client
      .from("articles")
      .select("*")
      .eq("workspace_id", WORKSPACE_A);
    if (!data) throw new Error("fixture returned no rows");
    expect(data.length).toBe(3);
    expect(leaksOtherWorkspace(data, WORKSPACE_A)).toBe(false);
  });

  it("counts only the scoped rows for a head count", async () => {
    // The exact shape behind the sidebar badge that read 4 beside a list of 2.
    const client = makeClient(seed);
    const scoped = await client
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", WORKSPACE_A);
    const unscoped = await client
      .from("articles")
      .select("id", { count: "exact", head: true });

    expect(scoped.count).toBe(3);
    expect(unscoped.count).toBe(6);
  });
});

describe("getRecentArticles", () => {
  it("no longer ignores the workspace when one is given", async () => {
    // The regression itself: it took only a limit, so the dashboard's recent
    // strip showed the other client's drafts under a scoped heading.
    const { getRecentArticles } = await import("../articles");
    const rows = await getRecentArticles(6, WORKSPACE_A);

    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.workspace_id === WORKSPACE_A)).toBe(true);
  });

  it("still returns the whole account when no workspace is given", async () => {
    // The argument is optional on purpose - callers without a scope (operator
    // views) should keep seeing everything RLS allows.
    const { getRecentArticles } = await import("../articles");
    const rows = await getRecentArticles(6);
    expect(rows.length).toBe(6);
  });
});

describe("getTrafficValue", () => {
  // Value is clicks × cpc, so a leak here is not a longer list but a bigger
  // number - the kind that reads as good news and gets put in a report.
  it("prices only the workspace it was given", async () => {
    const { getTrafficValue } = await import("../value");
    const v = await getTrafficValue(WORKSPACE_A);
    expect(v.clicks).toBe(3);
    expect(v.value).toBe(6);
  });

  it("sums the account, per site, when no workspace is given", async () => {
    const { getTrafficValue } = await import("../value");
    const v = await getTrafficValue();
    expect(v.clicks).toBe(6);
    expect(v.value).toBe(12);
  });
});

describe("getArticleValue", () => {
  it("counts only this workspace's rows for the article", async () => {
    // The fixture gives both workspaces rows under one article id, which the
    // real schema forbids; here it is the leak the filter has to refuse.
    const { getArticleValue } = await import("../value");
    const v = await getArticleValue("article-shared", WORKSPACE_A, "term 0");
    expect(v.clicks).toBe(3);
    expect(v.value).toBe(6);
  });
});
