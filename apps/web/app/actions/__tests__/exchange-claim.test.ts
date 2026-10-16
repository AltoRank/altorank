import { describe, it, expect, vi, beforeEach } from "vitest";

// Hosting a request claims it, then writes the draft after the response. The
// daily cron now releases a claim whose draft has not arrived after an hour,
// so the host's closing writes must apply only while it still holds the
// claim: a host finishing late must not overwrite, or release, a request
// another host has claimed since. And a claim update that matched no row (the
// other press won) must not go on to write and bill a draft.

type Row = {
  id: string;
  status: string;
  requester_account_id: string;
  provider_account_id: string | null;
  provider_workspace_id: string | null;
  provider_article_id: string | null;
  matched_at: string | null;
  target_url: string;
  target_keyword: string;
  target_topic: string;
  expires_at: string | null;
};

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Run between the claim and the closing write, like the cron firing mid-generation. */
  midGeneration: null as null | (() => void),
  /** Applied to the row right before the claim, like a second press landing first. */
  beforeClaim: null as null | (() => void),
  deferred: [] as Array<() => Promise<void>>,
  generated: 0,
  fail: false,
}));

function exchangeTable() {
  return {
    select: () => {
      const filters: Array<(r: Row) => boolean> = [];
      const b = {
        eq: (c: keyof Row, v: unknown) => (filters.push((r) => r[c] === v), b),
        maybeSingle: async () => ({ data: state.rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      };
      return b;
    },
    update: (values: Partial<Row>) => {
      const filters: Array<(r: Row) => boolean> = [];
      const apply = () => {
        if (values.status === "accepted") state.beforeClaim?.();
        const hit = state.rows.filter((r) => filters.every((f) => f(r)));
        for (const r of hit) Object.assign(r, values);
        return hit;
      };
      const b = {
        eq: (c: keyof Row, v: unknown) => (filters.push((r) => r[c] === v), b),
        is: (c: keyof Row, v: null) => (filters.push((r) => r[c] === v), b),
        select: async () => ({ data: apply().map((r) => ({ id: r.id })), error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve((apply(), { data: null, error: null })),
      };
      return b;
    },
  };
}

function articlesTable() {
  const b = {
    select: () => b,
    update: () => b,
    eq: () => b,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
  };
  return b;
}

const admin = { from: (t: string) => (t === "backlink_exchanges" ? exchangeTable() : articlesTable()) };

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => state.deferred.push(fn) }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ accountId: "host-acc" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => admin,
  createClient: async () => ({
    from: () => {
      const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { id: "ws-host", name: "Host", domain: "host.example", language: "en" } }) };
      return b;
    },
  }),
}));
vi.mock("@/lib/seo/exchange", () => ({
  CREDITS_PER_ARTICLE: 1,
  getCreditBalance: async () => 5,
  scoreRelevance: async () => 0.9,
  suggestPlacement: async () => ({ anchorText: "x", paragraphIndex: 1 }),
  insertBacklinkIntoContent: (c: unknown) => c,
}));
vi.mock("@/lib/seo/recommendations", () => ({
  recommendKeywords: async () => [{}],
  pickNextKeyword: () => ({ term: "garden sheds", reasons: [], score: 1, difficulty: 1, volume: 10 }),
}));
vi.mock("@/lib/content/generate", () => ({
  generateArticle: async () => {
    state.generated += 1;
    state.midGeneration?.();
    if (state.fail) throw new Error("model timed out");
    return { articleId: "art-late" };
  },
}));

const open = (): Row => ({
  id: "ex-1",
  status: "requested",
  requester_account_id: "req-acc",
  provider_account_id: null,
  provider_workspace_id: null,
  provider_article_id: null,
  matched_at: null,
  target_url: "https://target.example/page",
  target_keyword: "sheds",
  target_topic: "garden",
  expires_at: null,
});

function form(): FormData {
  const f = new FormData();
  f.set("exchange_id", "ex-1");
  f.set("workspace_id", "ws-host");
  return f;
}

async function settle() {
  for (const fn of state.deferred.splice(0)) await fn();
}

beforeEach(() => {
  state.rows = [open()];
  state.midGeneration = null;
  state.beforeClaim = null;
  state.deferred = [];
  state.generated = 0;
  state.fail = false;
});

describe("hostExchangeRequest: the claim", () => {
  it("writes nothing when the claim matched no row", async () => {
    // The other host's press lands between the read and the claim.
    state.beforeClaim = () => Object.assign(state.rows[0], { status: "accepted", provider_account_id: "other", provider_workspace_id: "ws-other" });
    const { hostExchangeRequest } = await import("../exchange");
    const r = await hostExchangeRequest(null, form());
    await settle();
    expect(r).toMatchObject({ ok: false });
    expect(state.generated).toBe(0);
    expect(state.rows[0]).toMatchObject({ provider_workspace_id: "ws-other", provider_article_id: null });
  });

  it("marks the request placed when it still holds the claim", async () => {
    const { hostExchangeRequest } = await import("../exchange");
    expect(await hostExchangeRequest(null, form())).toMatchObject({ ok: true });
    await settle();
    expect(state.rows[0]).toMatchObject({ status: "placed", provider_workspace_id: "ws-host", provider_article_id: "art-late" });
  });

  it("does not overwrite a request released and claimed by another host meanwhile", async () => {
    state.midGeneration = () =>
      Object.assign(state.rows[0], { status: "accepted", provider_account_id: "other", provider_workspace_id: "ws-other", matched_at: "later" });
    const { hostExchangeRequest } = await import("../exchange");
    await hostExchangeRequest(null, form());
    await settle();
    expect(state.rows[0]).toMatchObject({ status: "accepted", provider_workspace_id: "ws-other", provider_article_id: null });
  });

  it("does not release a claim it no longer holds when its own run fails late", async () => {
    state.fail = true;
    state.midGeneration = () =>
      Object.assign(state.rows[0], { status: "accepted", provider_account_id: "other", provider_workspace_id: "ws-other" });
    const { hostExchangeRequest } = await import("../exchange");
    await hostExchangeRequest(null, form());
    await settle();
    expect(state.rows[0]).toMatchObject({ status: "accepted", provider_workspace_id: "ws-other" });
  });
});
