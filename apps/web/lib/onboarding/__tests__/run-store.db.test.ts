// ---------------------------------------------------------------------------
// An onboarding run's last transitions, against Postgres itself
// ---------------------------------------------------------------------------
//
// run-store.test.ts runs these on an in-memory fake. This runs them through
// PostgREST into the local database, which is the only thing that can show:
//
// - migration 104's check constraint takes `nothing_planned` and the
//   `empty_pool` jsonb round-trips as the screen reads it;
// - the worker's claim and the dispatcher's close of an unclaimed run are one
//   conditional UPDATE each on `phases = '[]'`, so of the two racing exactly
//   one wins (2026-09-28: a dispatcher whose fetch had died stored a run as
//   failed while its worker was still going);
// - failRun reads what the run wrote - an article saved on the site since it
//   started - and settles on it instead of calling it a failure;
// - the empty-pool tally reads the verdicts out of `keywords.opportunity`
//   through the aliased jsonb select, paged.
//
// Seeds one account with invented names (acme-*.example) and deletes it at
// the end. ADMIN_EMAILS is unset for the file, so no operator email is tried.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { RunRecorder, failRun, latestRun, startRun } from "../run-store";
import { claimRun } from "../run-worker";
import { readEmptyPool } from "../empty-pool";
import { stateFromRun, onboardingOutcome, type EmptyPool, type OnboardingEvent } from "../events";

const STACK = await connectLocalStack();
const TAG = randomUUID().slice(0, 8);

describe.skipIf(!STACK)("onboarding run transitions on the local database", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId = "";
  const workspaceIds: string[] = [];
  const savedAdmins = process.env.ADMIN_EMAILS;

  async function site(): Promise<string> {
    const n = workspaceIds.length + 1;
    const { data, error } = await db
      .from("workspaces")
      .insert({ account_id: accountId, name: `acme-${TAG}-${n}.example`, domain: `acme-${TAG}-${n}.example`, initials: "AC", color: "av-c1" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`workspaces: ${error?.message}`);
    workspaceIds.push(data.id as string);
    return data.id as string;
  }

  async function newRun(workspaceId: string): Promise<string> {
    const started = await startRun(db, { id: workspaceId, account_id: accountId });
    if (!started.runId) throw new Error("no run started");
    return started.runId;
  }

  const row = async (runId: string) => {
    const { data, error } = await db.from("onboarding_runs").select("status, error, phases, empty_pool, finished_at").eq("id", runId).single();
    if (error) throw new Error(error.message);
    return data as { status: string; error: string | null; phases: unknown[]; empty_pool: EmptyPool | null; finished_at: string | null };
  };

  beforeAll(async () => {
    delete process.env.ADMIN_EMAILS;
    db = createServiceClient();
    const { data, error } = await db.from("accounts").insert({ name: `Acme runs ${TAG}`, slug: `acme-runs-${TAG}` }).select("id").single();
    if (error || !data) throw new Error(`accounts: ${error?.message}`);
    accountId = data.id as string;
  }, 30_000);

  afterAll(async () => {
    if (savedAdmins !== undefined) process.env.ADMIN_EMAILS = savedAdmins;
    if (!db) return;
    if (workspaceIds.length) await db.from("system_events").delete().in("workspace_id", workspaceIds);
    // Accounts cascade to workspaces, their runs, keywords and articles.
    if (accountId) await db.from("accounts").delete().eq("id", accountId);
  }, 30_000);

  it("stores a run that planned nothing as nothing_planned, with its empty pool, and reads it back as that outcome", async () => {
    const ws = await site();
    // The pool as the pipeline would find it: judged, none qualified.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ term: `acme widget ${TAG} ${i}`, opportunity: { status: "rejected", cause: "buyer_mismatch", reason: "r" } })),
      { term: `acme widget ${TAG} page`, opportunity: { status: "rejected", cause: "needs_page", reason: "r" } },
      { term: `acme widget ${TAG} open`, opportunity: null },
    ].map((r) => ({ workspace_id: ws, ...r }));
    const { error: kwError } = await db.from("keywords").insert(rows);
    expect(kwError).toBeNull();

    const pool = await readEmptyPool(db, ws);
    expect(pool).toMatchObject({ stage: "qualification", cause: "buyer_mismatch", keywords: 7, qualified: 0, rejected: { buyer_mismatch: 5, needs_page: 1 }, pending: { unjudged: 1 } });

    const runId = await newRun(ws);
    expect((await claimRun(db, runId)).outcome).toBe("claimed");
    const rec = new RunRecorder(db, runId);
    const events: OnboardingEvent[] = [
      { phase: "scanning", status: "done", detail: "Learned how your site writes." },
      { phase: "keywords", status: "done", detail: "Found 7 keywords.", keywordsFound: 7 },
      { phase: "pages", status: "done", detail: "Checked 3 pages." },
      { phase: "planning", status: "skipped", detail: "No keyword clear enough to plan yet.", planned: [], emptyPool: pool },
      { phase: "drafting", status: "skipped", detail: "No keyword clear enough to write to yet." },
      { phase: "ready" },
    ];
    for (const e of events) rec.record(e);
    await rec.finish();

    const stored = await row(runId);
    expect(stored).toMatchObject({ status: "nothing_planned", error: null, empty_pool: pool });
    expect(stored.finished_at).not.toBeNull();

    // What /state hands the screen, through the same select.
    const snapshot = await latestRun(db, ws);
    expect(snapshot.run?.status).toBe("nothing_planned");
    const outcome = onboardingOutcome(stateFromRun(snapshot.run, snapshot.article));
    expect(outcome.tone).toBe("nothing_planned");

    const { data: logged } = await db.from("system_events").select("level, source, context").eq("workspace_id", ws);
    expect(logged).toEqual([expect.objectContaining({ level: "warn", source: "onboarding.nothing_planned" })]);
    expect((logged?.[0].context as { rows?: number }).rows).toBe(7);
  });

  it("the check constraint still refuses a status nobody defined", async () => {
    const ws = await site();
    const runId = await newRun(ws);
    const { error } = await db.from("onboarding_runs").update({ status: "planned_nothing" }).eq("id", runId);
    expect(error?.code).toBe("23514");
    await failRun(db, runId, "cleanup");
  });

  it("of a worker's claim and the dispatcher's close of an unclaimed run, exactly one wins", async () => {
    for (let i = 0; i < 4; i++) {
      const ws = await site();
      const runId = await newRun(ws);
      const [claim, closed] = await Promise.all([claimRun(db, runId), failRun(db, runId, "The run could not be started: fetch failed", { unclaimedOnly: true })]);
      const after = await row(runId);
      if (claim.outcome === "claimed") {
        expect(closed).toBe(false);
        expect(after).toMatchObject({ status: "running", error: null });
        await failRun(db, runId, "cleanup");
      } else {
        expect(closed).toBe(true);
        expect(claim.outcome).toBe("already-finished");
        expect(after).toMatchObject({ status: "error", error: "The run could not be started: fetch failed" });
      }
    }
  });

  it("a dispatcher's close does not touch a run its worker has claimed", async () => {
    const ws = await site();
    const runId = await newRun(ws);
    expect((await claimRun(db, runId)).outcome).toBe("claimed");
    expect(await failRun(db, runId, "fetch failed", { unclaimedOnly: true })).toBe(false);
    expect(await row(runId)).toMatchObject({ status: "running", error: null });
    await failRun(db, runId, "cleanup");
  });

  it("failRun settles a run that wrote an article on what it wrote, not as a failure", async () => {
    const ws = await site();
    const runId = await newRun(ws);
    expect((await claimRun(db, runId)).outcome).toBe("claimed");
    // The draft route saved this; the row never pointed at it.
    const { error: artError } = await db.from("articles").insert({ workspace_id: ws, title: "Acme widgets explained", slug: `acme-widgets-${TAG}`, status: "review" });
    expect(artError).toBeNull();

    expect(await failRun(db, runId, "cut off at the ceiling")).toBe(true);
    expect(await row(runId)).toMatchObject({ status: "partial", error: null });
  });

  it("failRun still fails a run that wrote nothing - an older article on the site is not this run's", async () => {
    const ws = await site();
    const { error: artError } = await db
      .from("articles")
      .insert({ workspace_id: ws, title: "Older", slug: `acme-older-${TAG}`, status: "review", created_at: "2026-01-01T00:00:00Z" });
    expect(artError).toBeNull();
    const runId = await newRun(ws);
    expect(await failRun(db, runId, "boom")).toBe(true);
    expect(await row(runId)).toMatchObject({ status: "error", error: "boom" });
  });
});
