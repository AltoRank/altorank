import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * generateArticle is where every drafting door ends: cron/generate and
 * cron/refresh, /api/internal/draft (the onboarding worker's and the trial
 * resume's), the agent API and the MCP tool behind it, Write now, the editor
 * and the exchange. So the trial hold is enforced here whatever a door did or
 * forgot to ask: a trial-gated account ends up with its one pre-trial article
 * and no more (lib/billing/trial-hold.ts).
 *
 * The client below reaches as far as the research, which fails on purpose:
 * a run that opened its job and asked for research is a run that would have
 * called the model, and that is the line the hold must stop short of. A run
 * that stops before the job row (`jobFails`) has bought nothing, and gives
 * the pre-trial draft back (round-5 review).
 */

const getQuota = vi.fn();
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: (...args: unknown[]) => getQuota(...args),
}));

vi.mock("@/lib/seo/research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/research")>()),
  gatherArticleResearch: async () => {
    // A real draft holds its row for minutes. Held here long enough for every
    // racer's re-check to see it, before the failure below.
    await new Promise((r) => setTimeout(r, 25));
    throw new Error("stop here: research failed");
  },
}));
vi.mock("@/lib/content/site-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/site-facts")>()),
  loadSiteFacts: async () => null,
}));

import { generateArticle } from "../generate";
import { TrialHoldError } from "@/lib/billing/trial-hold";
import { BODY_LOCKED_MESSAGE, TRIAL_HOLD_MESSAGE } from "@/lib/billing/trial-refusal";

/** The account's articles, shared by every client in a test: id -> status. */
const rows = new Map<string, string>();
/** The rows getQuota counts: every one but `error`. */
const counted = () => [...rows.values()].filter((st) => st !== "error").length;
/** Stop the run at the job row instead: nothing bought yet. */
let jobFails = false;
/** Every filter the text check (articleHasText) applied, as "op column value". */
const textFilters: string[] = [];
let nextId = 0;
let jobsOpened = 0;
let inserted = 0;
/** What an in-place target article looks like; `text` is whether it has any. */
let target: { id: string; status: string; text?: boolean } | null = null;
/** accounts.free_drafts_used, which claimPreTrialDraft moves by compare-and-set. */
let claimed = 0;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function client() {
  const workspace = {
    id: "ws1",
    account_id: "acc1",
    domain: "acme-agency.example",
    ai_provider: null,
    ai_model: null,
    language: null,
    brand_style: null,
    location_code: null,
    status: "active",
    paused_until: null,
    business_profile: null,
  };
  return {
    from: (table: string) => {
      if (table === "articles") {
        // Also the tie-break's read of the account's earliest drafts: the
        // shared rows in insertion order, which is created_at order here.
        let limit = Infinity;
        // `.not("content", "is", null)` is the text check (articleHasText).
        let askingForText = false;
        const filters: string[] = [];
        const chain: Record<string, unknown> = {
          eq: () => chain,
          in: () => chain,
          neq: (col: string, v: unknown) => (filters.push(`neq ${col} ${JSON.stringify(v)}`), chain),
          not: (col: string, op: string, v: unknown) => {
            askingForText = col === "content";
            filters.push(`not ${col} ${op} ${JSON.stringify(v)}`);
            return chain;
          },
          order: () => chain,
          limit: (n: number) => ((limit = n), chain),
          maybeSingle: async () => {
            if (!askingForText) return { data: target, error: null };
            textFilters.push(...filters);
            return { data: target?.text ? { id: target.id } : null, error: null };
          },
          single: async () => ({ data: target, error: target ? null : { message: "not found" } }),
          then: (resolve: (v: unknown) => unknown) =>
            tick().then(() =>
              resolve({
                data: [...rows].filter(([, st]) => st !== "error").slice(0, limit).map(([id]) => ({ id })),
                error: null,
              }),
            ),
        };
        return {
          select: () => chain,
          insert: () => ({
            select: () => ({
              single: async () => {
                await tick();
                const id = `a${++nextId}`;
                rows.set(id, "drafting");
                inserted += 1;
                return { data: { id }, error: null };
              },
            }),
          }),
          update: (patch: { status?: string }) => ({
            eq: async (_col: string, id: string) => {
              if (patch.status && rows.has(id)) rows.set(id, patch.status);
              return { error: null };
            },
          }),
          delete: () => ({
            eq: async (_col: string, id: string) => {
              rows.delete(id);
              return { error: null };
            },
          }),
        };
      }
      if (table === "accounts") {
        const read: Record<string, unknown> = {
          eq: () => read,
          maybeSingle: async () => {
            await tick();
            return { data: { free_drafts_used: claimed }, error: null };
          },
        };
        return {
          select: () => read,
          update: (patch: { free_drafts_used: number }) => {
            const expected: Record<string, unknown> = {};
            const cas: Record<string, unknown> = {
              eq: (col: string, v: unknown) => ((expected[col] = v), cas),
              select: async () => {
                await tick();
                if ("free_drafts_used" in expected && expected.free_drafts_used !== claimed) return { data: [], error: null };
                claimed = patch.free_drafts_used;
                return { data: [{ id: "acc1" }], error: null };
              },
              then: (resolve: (v: unknown) => unknown) => {
                if (!("free_drafts_used" in expected) || expected.free_drafts_used === claimed) claimed = patch.free_drafts_used;
                return resolve({ error: null });
              },
            };
            return cas;
          },
        };
      }
      if (table === "generation_jobs") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => {
                if (jobFails) return { data: null, error: { message: "jobs table unavailable" } };
                jobsOpened += 1;
                return { data: { id: `job${jobsOpened}` }, error: null };
              },
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      const chain: Record<string, unknown> = {
        eq: () => chain,
        ilike: () => chain,
        limit: () => chain,
        single: async () => ({ data: workspace, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        // The account's sites, for the tie-break.
        then: (resolve: (v: unknown) => unknown) => resolve({ data: table === "workspaces" ? [{ id: "ws1" }] : [], error: null }),
      };
      return { select: () => chain };
    },
  } as never;
}

/**
 * A trial-gated account: no plan, never trialed. `used` is what getQuota
 * reads: the larger of the stored counter and the rows that count.
 */
function gatedQuota() {
  getQuota.mockImplementation(async () => {
    await tick();
    const used = Math.max(counted(), claimed);
    return { limit: 7, used, remaining: Math.max(0, 7 - used), reason: "no-plan", plan: null, trialEligible: true };
  });
}

/** "reached the model" when the run opened its job (where the fake stops it), else the refusal. */
const draft = (i = 0, extra: Record<string, unknown> = {}) => {
  const before = jobsOpened;
  return generateArticle({ supabase: client(), workspaceId: "ws1", keyword: `keyword ${i}`, callerEmail: null, ...extra } as never).then(
    () => "reached the model",
    (e: Error) => (jobsOpened > before && /stop here/.test(e.message) ? "reached the model" : e),
  );
};

beforeEach(() => {
  rows.clear();
  nextId = 0;
  jobsOpened = 0;
  inserted = 0;
  target = null;
  claimed = 0;
  jobFails = false;
  textFilters.length = 0;
  getQuota.mockReset();
  delete process.env.TRIAL_GATE_DISABLED;
});
afterEach(() => {
  delete process.env.TRIAL_GATE_DISABLED;
});

describe("generateArticle and the trial hold", () => {
  it("writes a gated account's first article", async () => {
    gatedQuota();
    expect(await draft()).toBe("reached the model");
    expect(jobsOpened).toBe(1);
  });

  it("refuses the second before any row or model call, with the hold's own error", async () => {
    gatedQuota();
    rows.set("first", "review");
    const out = await draft();
    expect(out).toBeInstanceOf(TrialHoldError);
    expect((out as Error).message).toBe(TRIAL_HOLD_MESSAGE);
    expect(inserted).toBe(0);
    expect(jobsOpened).toBe(0);
  });

  it("lets exactly one of several racing first drafts reach the model: the earliest", async () => {
    gatedQuota();
    const outs = await Promise.all([0, 1, 2, 3].map((i) => draft(i)));
    // Each counted the others' rows and saw a race. Refusing on the count
    // alone refused all four, leaving the account with no article and a
    // message saying its first one was written. The earliest row wins.
    expect(outs.filter((o) => o === "reached the model")).toHaveLength(1);
    expect(outs[0]).toBe("reached the model");
    expect(jobsOpened).toBe(1);
    for (const o of outs.slice(1)) expect(o).toBeInstanceOf(TrialHoldError);
    // Every refused run took its own row back; the winner's failed and is
    // left `error`, which counts for nothing - the claim is what counts.
    expect([...rows.values()]).toEqual(["error"]);
    expect(claimed).toBe(1);
  });

  it("does not hold a paying or trialing account", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 40, remaining: 60, reason: "plan", plan: "starter" });
    rows.set("first", "review");
    expect(await draft()).toBe("reached the model");
  });

  it("does not hold a self-hosted install", async () => {
    getQuota.mockResolvedValue({ limit: null, used: 40, remaining: null, reason: "self-host", plan: null, trialEligible: true });
    expect(await draft()).toBe("reached the model");
  });

  it("does not hold an account that already had its trial", async () => {
    getQuota.mockResolvedValue({ limit: 7, used: 3, remaining: 4, reason: "no-plan", plan: null, trialEligible: false });
    expect(await draft()).toBe("reached the model");
  });

  it("is off with the gate's kill switch", async () => {
    process.env.TRIAL_GATE_DISABLED = "1";
    gatedQuota();
    rows.set("first", "review");
    expect(await draft()).toBe("reached the model");
  });

  it("refuses to regenerate the first article before the trial: that is working on its text", async () => {
    // It adds no draft, but each regeneration bought the research, the model
    // call and the fact check again, as often as an agent key asked.
    gatedQuota();
    rows.set("first", "review");
    target = { id: "first", status: "review", text: true };
    const out = await draft(0, { articleId: "first" });
    expect(out).toBeInstanceOf(TrialHoldError);
    expect((out as Error).message).toBe(BODY_LOCKED_MESSAGE);
    expect(jobsOpened).toBe(0);
  });

  it("lets an address on the bypass list regenerate in place: its bodies are open", async () => {
    process.env.TRIAL_GATE_BYPASS_EMAILS = "tester@acme-agency.example";
    try {
      gatedQuota();
      rows.set("first", "review");
      target = { id: "first", status: "review", text: true };
      expect(await draft(0, { articleId: "first", callerEmail: "tester+x@acme-agency.example" })).toBe("reached the model");
    } finally {
      delete process.env.TRIAL_GATE_BYPASS_EMAILS;
    }
  });

  it("holds a regeneration into a failed article, which would add one", async () => {
    gatedQuota();
    rows.set("first", "review");
    target = { id: "failed", status: "error" };
    expect(await draft(0, { articleId: "failed" })).toBeInstanceOf(TrialHoldError);
    expect(jobsOpened).toBe(0);
  });

  it("holds a rewrite of an existing page: it is a draft too", async () => {
    gatedQuota();
    rows.set("first", "review");
    const out = await draft(0, { refreshOf: { url: "https://acme-agency.example/a", existingHtml: "<p>x</p>", brief: null } });
    expect(out).toBeInstanceOf(TrialHoldError);
    expect(jobsOpened).toBe(0);
  });

  it("writes the first draft into a row the agent API inserted for it", async () => {
    // The route inserts a `drafting` row and generates into it. Read as "an
    // article that counts", that row was refused as a regeneration after the
    // 202 had gone: no gated account's first draft over the API could land.
    gatedQuota();
    rows.set("r1", "drafting");
    target = { id: "r1", status: "drafting", text: false };
    expect(await draft(0, { articleId: "r1" })).toBe("reached the model");
    expect(claimed).toBe(1);
  });

  it("counts the attempt: a first draft that failed does not buy another", async () => {
    // Round-4 review: the counter was written only after a save, so a draft
    // that failed (or was flipped to `error` by the account's own client)
    // counted for nothing, and the next one was bought, without limit.
    gatedQuota();
    expect(await draft()).toBe("reached the model");
    expect(claimed).toBe(1);
    expect(counted()).toBe(0); // the run failed after its research was bought; its row is `error`
    target = { id: "e1", status: "error", text: false };
    const again = await draft(1, { articleId: "e1" });
    expect(again).toBeInstanceOf(TrialHoldError);
    expect(jobsOpened).toBe(1);
  });

  it("asks for text with a filter a jsonb column accepts", async () => {
    // `content` is jsonb. `.neq("content", "")` became `content <> ''::jsonb`
    // on a real PostgREST, which fails with 22P02 on every call, and took every
    // in-place draft with it; this fake's `neq` was a no-op, so nothing here
    // noticed (round-5 review). The check is "not null", and only that.
    gatedQuota();
    rows.set("r1", "drafting");
    target = { id: "r1", status: "drafting", text: false };
    await draft(0, { articleId: "r1" });
    expect(textFilters).toEqual(["not content is null"]);
  });

  it("gives the pre-trial draft back when the run stops before anything is bought", async () => {
    // The job row is the line: before it only our own rows are touched. A
    // failure there left the account with no article, no way to one before
    // the trial, and nothing spent.
    gatedQuota();
    jobFails = true;
    const out = await draft();
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/generation job/);
    expect(claimed).toBe(0);
    expect(rows.size).toBe(0);
    jobFails = false;
    expect(await draft(1)).toBe("reached the model");
    expect(claimed).toBe(1);
  });

  it("gives it back when the row to write into is gone", async () => {
    gatedQuota();
    // The hold's read finds the row; by the write it is gone (deleted by the
    // account's own client in between, or never in this site).
    let reads = 0;
    target = { id: "r1", status: "drafting", text: false };
    const run = generateArticle({
      supabase: new Proxy(client() as object, {
        get(obj, prop) {
          if (prop !== "from") return (obj as Record<string | symbol, unknown>)[prop];
          return (table: string) => {
            const inner = (obj as { from: (t: string) => Record<string, unknown> }).from(table);
            if (table !== "articles") return inner;
            reads += 1;
            // The hold's status read and the text check pass; the in-place
            // resolve (`.single()`) finds nothing.
            if (reads >= 3) target = null;
            return inner;
          };
        },
      }) as never,
      workspaceId: "ws1",
      keyword: "keyword",
      articleId: "r1",
      callerEmail: null,
    } as never);
    await expect(run).rejects.toThrow(/Article not found/);
    expect(jobsOpened).toBe(0);
    expect(claimed).toBe(0);
  });

  it("keeps the claim once the research is bought", async () => {
    gatedQuota();
    expect(await draft()).toBe("reached the model");
    expect(claimed).toBe(1);
  });

  it("lets exactly one of several failed rows fired at once be drafted", async () => {
    gatedQuota();
    target = { id: "e1", status: "error", text: false };
    const outs = await Promise.all([0, 1, 2].map((i) => draft(i, { articleId: "e1" })));
    expect(outs.filter((o) => o === "reached the model")).toHaveLength(1);
    expect(jobsOpened).toBe(1);
    expect(claimed).toBe(1);
  });
});
