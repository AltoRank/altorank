// ---------------------------------------------------------------------------
// A first look's budget, against Postgres itself
// ---------------------------------------------------------------------------
//
// spend-scope.test.ts runs the claims on an in-memory budget. This runs them
// through PostgREST into the local database (migration 106), which is the
// only thing that can show:
//
// - the reserves hold: research cannot claim the draft's or the swap's
//   reserve, and the draft can use its own reserve plus what research left;
// - concurrent claims take turns on the row lock, so thirty claims racing for
//   one run never commit more than its room allows;
// - a settle moves the run by (actual - estimate) and fills the stage split;
// - a client token can neither read the table nor call the functions;
// - a spend row written inside the scope carries the run id and the stage.
//
// Seeds one account (b14 spend, acme-*.example) and deletes it at the end.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { FIRST_LOOK_DRAFT_RESERVE_USD, FIRST_LOOK_SWAP_RESERVE_USD, openRunBudget, readRunBudget, runBudget } from "../run-budget";
import { recordSpend } from "../spend";
import { withSpendScope } from "../spend-scope";

const STACK = await connectLocalStack();
const TAG = `b14-spend-${randomUUID().slice(0, 8)}`;
const DRAFT = FIRST_LOOK_DRAFT_RESERVE_USD;
const SWAP = FIRST_LOOK_SWAP_RESERVE_USD;
/** What research and judging may claim on a $1 run: the ceiling less both reserves. */
const RESEARCH = 1 - DRAFT - SWAP;

describe.skipIf(!STACK)("run budgets on the local database", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId = "";
  let workspaceId = "";

  async function run(): Promise<string> {
    const { data, error } = await db.from("onboarding_runs").insert({ workspace_id: workspaceId, account_id: accountId }).select("id").single();
    if (error || !data) throw new Error(`onboarding_runs: ${error?.message}`);
    // A run row is `running` until settled; settle it so the one-running-run
    // index lets the next test open another.
    await db.from("onboarding_runs").update({ status: "done" }).eq("id", data.id);
    return data.id as string;
  }

  beforeAll(async () => {
    db = createServiceClient();
    const { data, error } = await db.from("accounts").insert({ name: `${TAG} account`, slug: TAG }).select("id").single();
    if (error || !data) throw new Error(`accounts: ${error?.message}`);
    accountId = data.id as string;
    const ws = await db
      .from("workspaces")
      .insert({ account_id: accountId, name: `acme-${TAG}.example`, domain: `acme-${TAG}.example`, initials: "AC", color: "av-c1" })
      .select("id")
      .single();
    if (ws.error || !ws.data) throw new Error(`workspaces: ${ws.error?.message}`);
    workspaceId = ws.data.id as string;
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    if (workspaceId) await db.from("provider_spend").delete().eq("workspace_id", workspaceId);
    // Accounts cascade to workspaces and runs; runs cascade to their budgets.
    if (accountId) await db.from("accounts").delete().eq("id", accountId);
  }, 30_000);

  it("holds the draft's and the swap's reserves back from research, and lets the draft use what research left", async () => {
    const budget = (await openRunBudget(db, { runId: await run(), workspaceId }))!;
    expect(budget).not.toBeNull();
    expect(await budget.room("discovery")).toBeCloseTo(RESEARCH, 6);
    expect(await budget.room("draft")).toBeCloseTo(1 - SWAP, 6);
    expect(await budget.claim("discovery", RESEARCH - 0.05, RESEARCH - 0.05)).toBeCloseTo(RESEARCH - 0.05, 6);
    // Research has 0.05 left; the draft still has its reserve and that 0.05.
    expect(await budget.claim("judge", 0.1, 0.1)).toBeNull();
    expect(await budget.claim("judge", 0.1, 0.01)).toBeCloseTo(0.05, 6);
    expect(await budget.room("draft")).toBeCloseTo(DRAFT, 6);
    expect(await budget.claim("draft", 0.64, 0.2)).toBeCloseTo(DRAFT, 6);
    expect(await budget.claim("draft", 0.01, 0.01)).toBeNull();
  });

  it("settles a claim at what was charged, and keeps the estimate when no price came back", async () => {
    const runId = await run();
    const budget = (await openRunBudget(db, { runId, workspaceId }))!;
    const granted = (await budget.claim("results_pages", 0.004, 0.004))!;
    await budget.settle("results_pages", granted, 0.002);
    const unpriced = (await budget.claim("judge", 0.02, 0.02))!;
    await budget.settle("judge", unpriced, null);
    const state = await readRunBudget(db, runId);
    expect(state?.committedUsd).toBeCloseTo(0.022, 6);
    expect(state?.stages.results_pages).toMatchObject({ spent: 0.002, calls: 1 });
    expect(state?.stages.judge).toMatchObject({ spent: 0.02, calls: 1 });
    expect(state?.refused).toBe(0);
  });

  it("does not hand a retried run a second dollar", async () => {
    const runId = await run();
    const first = (await openRunBudget(db, { runId, workspaceId }))!;
    await first.claim("discovery", 0.4, 0.4);
    const again = (await openRunBudget(db, { runId, workspaceId }))!;
    expect(await again.room("discovery")).toBeCloseTo(RESEARCH - 0.4, 6);
  });

  it("never commits past the ceiling, however many claims race", async () => {
    const runId = await run();
    const budget = runBudget(db, runId);
    await openRunBudget(db, { runId, workspaceId });
    const grants = await Promise.all(Array.from({ length: 30 }, () => budget.claim("judge", 0.05, 0.05)));
    const granted = grants.filter((g) => g !== null);
    // The research room at 0.05 a claim, and the rest refused.
    const fits = Math.floor(RESEARCH / 0.05 + 1e-9);
    expect(fits).toBeLessThan(30);
    expect(granted).toHaveLength(fits);
    const state = await readRunBudget(db, runId);
    expect(state?.committedUsd).toBeCloseTo(fits * 0.05, 6);
    expect(state?.refused).toBe(30 - fits);
    expect(state?.stages.judge?.refused).toBe(30 - fits);
  });

  it("is server only: a signed-in client reads no budget and calls no claim", async () => {
    const runId = await run();
    await openRunBudget(db, { runId, workspaceId });
    const anon = createClient(STACK!.url, STACK!.anon, { auth: { persistSession: false } });
    const read = await anon.from("run_budgets").select("run_id").eq("run_id", runId);
    expect(read.data ?? []).toEqual([]);
    const claim = await anon.rpc("run_budget_claim", { p_run_id: runId, p_stage: "judge", p_want: 0.01, p_min: 0.01 });
    expect(claim.error).not.toBeNull();
  });

  it("writes a first look's spend rows with the run's id and the stage they were bought in", async () => {
    const runId = await run();
    const budget = await openRunBudget(db, { runId, workspaceId });
    await withSpendScope({ workspaceId, runId, budget, stage: "judge" }, () =>
      recordSpend(db, { provider: "anthropic", operation: "keyword-research/opportunity", costUsd: 0.0123, runId: "a-generation-job" }),
    );
    const { data } = await db.from("provider_spend").select("workspace_id, run_id, stage, cost_usd").eq("run_id", runId);
    expect(data).toEqual([{ workspace_id: workspaceId, run_id: runId, stage: "judge", cost_usd: 0.0123 }]);
  });
});
