import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * generateArticle is where every drafting door ends: cron/generate and
 * cron/refresh, /api/internal/draft (the onboarding worker's and the trial
 * resume's), the agent API and the MCP tool behind it, Write now, the editor
 * and the exchange. So the trial hold is enforced here whatever a door did or
 * forgot to ask: a trial-gated account ends up with its one pre-trial article
 * and no more (lib/billing/trial-hold.ts).
 *
 * The client below reaches as far as the generation job insert, which fails
 * on purpose: a run that opened a job is a run that would have called the
 * model, and that is the line the hold must stop short of.
 */

const getQuota = vi.fn();
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: (...args: unknown[]) => getQuota(...args),
}));

import { generateArticle } from "../generate";
import { TrialHoldError, TRIAL_HOLD_MESSAGE } from "@/lib/billing/trial-hold";

/** The account's articles, shared by every client in a test, as ids. */
const rows = new Set<string>();
let nextId = 0;
let jobsOpened = 0;
let inserted = 0;
/** What an in-place target article looks like. */
let target: { id: string; status: string } | null = null;

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
        const chain: Record<string, unknown> = {
          eq: () => chain,
          maybeSingle: async () => ({ data: target, error: null }),
          single: async () => ({ data: target, error: target ? null : { message: "not found" } }),
        };
        return {
          select: () => chain,
          insert: () => ({
            select: () => ({
              single: async () => {
                await tick();
                const id = `a${++nextId}`;
                rows.add(id);
                inserted += 1;
                return { data: { id }, error: null };
              },
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
          delete: () => ({
            eq: async (_col: string, id: string) => {
              rows.delete(id);
              return { error: null };
            },
          }),
        };
      }
      if (table === "generation_jobs") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => {
                jobsOpened += 1;
                return { data: null, error: { message: "stop here" } };
              },
            }),
          }),
        };
      }
      const chain: Record<string, unknown> = {
        eq: () => chain,
        ilike: () => chain,
        limit: () => chain,
        single: async () => ({ data: workspace, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return { select: () => chain };
    },
  } as never;
}

/** A trial-gated account: no plan, never trialed. `used` counts the shared rows. */
function gatedQuota() {
  getQuota.mockImplementation(async () => {
    await tick();
    const used = rows.size;
    return { limit: 7, used, remaining: Math.max(0, 7 - used), reason: "no-plan", plan: null, trialEligible: true };
  });
}

/** "reached the model" when the run opened its job (where the fake stops it), else the refusal. */
const draft = (i = 0, extra: Record<string, unknown> = {}) => {
  const before = jobsOpened;
  return generateArticle({ supabase: client(), workspaceId: "ws1", keyword: `keyword ${i}`, callerEmail: null, ...extra } as never).then(
    () => "reached the model",
    (e: Error) => (jobsOpened > before && /generation job/.test(e.message) ? "reached the model" : e),
  );
};

beforeEach(() => {
  rows.clear();
  nextId = 0;
  jobsOpened = 0;
  inserted = 0;
  target = null;
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
    rows.add("first");
    const out = await draft();
    expect(out).toBeInstanceOf(TrialHoldError);
    expect((out as Error).message).toBe(TRIAL_HOLD_MESSAGE);
    expect(inserted).toBe(0);
    expect(jobsOpened).toBe(0);
  });

  it("lets at most one of several racing first drafts reach the model", async () => {
    gatedQuota();
    const outs = await Promise.all([0, 1, 2, 3].map((i) => draft(i)));
    // Refusing all of them is possible (each counted the others' rows) and
    // leaves the first article to a retry; letting two through is not.
    expect(outs.filter((o) => o === "reached the model").length).toBeLessThanOrEqual(1);
    expect(jobsOpened).toBeLessThanOrEqual(1);
    for (const o of outs) if (o !== "reached the model") expect(o).toBeInstanceOf(TrialHoldError);
    // Every refused run took its own row back.
    expect(rows.size).toBe(0);
  });

  it("does not hold a paying or trialing account", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 40, remaining: 60, reason: "plan", plan: "starter" });
    rows.add("first");
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
    rows.add("first");
    expect(await draft()).toBe("reached the model");
  });

  it("lets the first article be regenerated in place, since that adds no draft", async () => {
    gatedQuota();
    rows.add("first");
    target = { id: "first", status: "review" };
    expect(await draft(0, { articleId: "first" })).toBe("reached the model");
  });

  it("holds a regeneration into a failed article, which would add one", async () => {
    gatedQuota();
    rows.add("first");
    target = { id: "failed", status: "error" };
    expect(await draft(0, { articleId: "failed" })).toBeInstanceOf(TrialHoldError);
    expect(jobsOpened).toBe(0);
  });

  it("holds a rewrite of an existing page: it is a draft too", async () => {
    gatedQuota();
    rows.add("first");
    const out = await draft(0, { refreshOf: { url: "https://acme-agency.example/a", existingHtml: "<p>x</p>", brief: null } });
    expect(out).toBeInstanceOf(TrialHoldError);
    expect(jobsOpened).toBe(0);
  });
});
