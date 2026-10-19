import { describe, expect, it, vi, beforeEach } from "vitest";
import { recordArticlesApproved, recordRunStarted, recordTrialStarted, stepEventId } from "../step-events";
import { stepKey } from "../step-props";

// The server's own steps: a run started (and what started it), a trial
// started (Stripe's word), an article approved. Written once each through the
// same upsert as every onboarding.step; the db here records what was sent.

type Upsert = { id: string; workspace_id: string | null; account_id: string | null; context: Record<string, unknown>; message: string };

function fakeDb(opts: { otherRuns?: number; runsReadFails?: boolean; accounts?: Record<string, string>; accountsReadThrows?: boolean } = {}) {
  const upserts: Upsert[] = [];
  const db = {
    from: (table: string) => {
      if (table === "system_events") {
        return {
          upsert: (row: Upsert) => ({
            select: async () => {
              const dupe = upserts.some((u) => u.id === row.id);
              if (!dupe) upserts.push(row);
              return { data: dupe ? [] : [{ id: row.id }], error: null };
            },
          }),
        };
      }
      if (table === "onboarding_runs") {
        const q = {
          select: () => q,
          eq: () => q,
          neq: () => q,
          limit: async () =>
            opts.runsReadFails ? { data: null, error: { message: "down" } } : { data: Array.from({ length: opts.otherRuns ?? 0 }, (_, i) => ({ id: `r${i}` })), error: null },
        };
        return q;
      }
      if (table === "workspaces") {
        return {
          select: () => ({
            in: async (_c: string, ids: string[]) => {
              if (opts.accountsReadThrows) throw new Error("unreachable");
              return { data: ids.filter((id) => opts.accounts?.[id]).map((id) => ({ id, account_id: opts.accounts![id] })), error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { db: db as never, upserts };
}

const WS1 = "00000000-0000-4000-8000-0000000000a1";
const WS2 = "00000000-0000-4000-8000-0000000000a2";
const ACC = "00000000-0000-4000-8000-0000000000c1";
const RUN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RUN2 = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const ART = "11111111-2222-4333-8444-555555555555";
const ART2 = "11111111-2222-4333-8444-666666666666";

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));

describe("recordRunStarted", () => {
  it("calls a site's only run its first, and any later one a rerun, once per run", async () => {
    const first = fakeDb({ otherRuns: 0 });
    expect(await recordRunStarted(first.db, { workspaceId: WS1, accountId: ACC, userId: "u1", runId: RUN })).toBe(true);
    expect(first.upserts[0]).toMatchObject({
      id: stepEventId(WS1, "run_started", stepKey("run_started", { runId: RUN })),
      workspace_id: WS1,
      account_id: ACC,
      context: { step: "run_started", userId: "u1", runId: RUN, trigger: "first" },
    });
    const again = fakeDb({ otherRuns: 1 });
    await recordRunStarted(again.db, { workspaceId: WS1, accountId: ACC, userId: "u1", runId: RUN2 });
    expect(again.upserts[0].context).toMatchObject({ trigger: "rerun", runId: RUN2 });
  });

  it("takes the trigger it is given, and leaves it out rather than guess when the runs cannot be read", async () => {
    const retry = fakeDb();
    await recordRunStarted(retry.db, { workspaceId: WS1, accountId: ACC, userId: null, runId: RUN, trigger: "provider_retry" });
    expect(retry.upserts[0].context).toEqual({ step: "run_started", runId: RUN, trigger: "provider_retry" });
    const blind = fakeDb({ runsReadFails: true });
    await recordRunStarted(blind.db, { workspaceId: WS1, accountId: ACC, userId: null, runId: RUN });
    expect(blind.upserts[0].context).toEqual({ step: "run_started", runId: RUN });
  });

  it("writes a run once however often it is said", async () => {
    const { db, upserts } = fakeDb();
    await recordRunStarted(db, { workspaceId: WS1, accountId: null, userId: null, runId: RUN, trigger: "first" });
    expect(await recordRunStarted(db, { workspaceId: WS1, accountId: null, userId: null, runId: RUN, trigger: "first" })).toBe(false);
    expect(upserts).toHaveLength(1);
  });
});

describe("recordTrialStarted", () => {
  it("writes the trial once per site of the account, with the plan and nothing else", async () => {
    const { db, upserts } = fakeDb();
    await recordTrialStarted(db, { accountId: ACC, workspaceIds: [WS1, WS2, WS1], plan: "growth" });
    expect(upserts.map((u) => u.workspace_id)).toEqual([WS1, WS2]);
    expect(upserts[0]).toMatchObject({ account_id: ACC, context: { step: "trial_started", plan: "growth" } });
    expect(upserts[0].id).toBe(stepEventId(WS1, "trial_started"));
    // Stripe delivers an event more than once: the second delivery writes nothing.
    await recordTrialStarted(db, { accountId: ACC, workspaceIds: [WS1], plan: "growth" });
    expect(upserts).toHaveLength(2);
  });

  it("drops a plan it does not sell rather than write it", async () => {
    const { db, upserts } = fakeDb();
    await recordTrialStarted(db, { accountId: ACC, workspaceIds: [WS1], plan: "enterprise" });
    expect(upserts[0].context).toEqual({ step: "trial_started" });
  });
});

describe("recordArticlesApproved", () => {
  it("writes each approval once per article, on its site and account", async () => {
    const { db, upserts } = fakeDb({ accounts: { [WS1]: ACC } });
    await recordArticlesApproved(
      db,
      [
        { id: ART, workspaceId: WS1, status: "scheduled" },
        { id: ART2, workspaceId: WS1, status: "approved" },
      ],
      "u1",
    );
    expect(upserts.map((u) => u.context)).toEqual([
      { step: "article_approved", userId: "u1", articleId: ART, status: "scheduled" },
      { step: "article_approved", userId: "u1", articleId: ART2, status: "approved" },
    ]);
    expect(upserts.every((u) => u.account_id === ACC && u.workspace_id === WS1)).toBe(true);
    // Approved, edited (approved_at cleared), approved again: still the first one.
    await recordArticlesApproved(db, [{ id: ART, workspaceId: WS1, status: "approved" }], "u1");
    expect(upserts).toHaveLength(2);
  });

  it("still writes the approval when the account cannot be read, and never throws", async () => {
    const { db, upserts } = fakeDb({ accountsReadThrows: true });
    await expect(recordArticlesApproved(db, [{ id: ART, workspaceId: WS1, status: "approved" }], null)).resolves.toBeUndefined();
    expect(upserts[0]).toMatchObject({ account_id: null, workspace_id: WS1 });
  });

  it("does nothing for nothing approved", async () => {
    const { db, upserts } = fakeDb();
    await recordArticlesApproved(db, [], "u1");
    expect(upserts).toHaveLength(0);
  });
});
