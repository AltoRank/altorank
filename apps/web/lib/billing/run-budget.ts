// ---------------------------------------------------------------------------
// A first look's dollar, held in the database
// ---------------------------------------------------------------------------
//
// $1 a first look, the article included (founder decision 2026-09-29). It
// used to be a check made after the fact - qualification summed the site's
// provider_spend since the run started and stopped once the sum crossed the
// ceiling less the draft's share - which let calls in flight land above it
// (2 of 9 live runs: $1.031, $1.004) and held nothing back for a draft that
// is written in another invocation.
//
// Now a run opens a `run_budgets` row (migration 106) and every paid call of
// the first look claims its estimate from it before it is made, in one locked
// update (`run_budget_claim`), then settles it with what the provider charged
// (`run_budget_settle`). The draft's reserve is held for the draft: the
// research and the judging cannot claim it, and the draft may also use what
// they left. The row is keyed by the run, so the draft route opens the same
// budget the worker did.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunBudget, SpendStage } from "./spend-scope";

/** $1 a first look, the article included (founder decision 2026-09-29). */
export const FIRST_LOOK_CEILING_USD = 1;
/**
 * Held for the first draft: research, the writer and the fact check on the
 * content tier. An estimate, not a measurement; the stage's spend rows say
 * what it was.
 */
export const FIRST_LOOK_DRAFT_RESERVE_USD = 0.3;
/** Held for the founder gate's one outline swap before the trial (not built yet). */
export const FIRST_LOOK_SWAP_RESERVE_USD = 0.05;

/**
 * The ceiling a first look opens with. `FIRST_LOOK_BUDGET_USD` lowers it for
 * a proof run (a forced $0.50 shows the run stopping); it never raises it, and
 * a value that is not a positive number is ignored.
 */
export function firstLookCeiling(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FIRST_LOOK_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, FIRST_LOOK_CEILING_USD) : FIRST_LOOK_CEILING_USD;
}

export function firstLookReserves(): Partial<Record<SpendStage, number>> {
  return { draft: FIRST_LOOK_DRAFT_RESERVE_USD, outline_swap: FIRST_LOOK_SWAP_RESERVE_USD };
}

/** The budget row as stored: what the funnel event reports. */
export interface RunBudgetState {
  ceilingUsd: number;
  committedUsd: number;
  refused: number;
  stages: Partial<Record<SpendStage, { committed?: number; spent?: number; calls?: number; refused?: number }>>;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A claim interface over the run's row. Every call goes to the database. */
export function runBudget(db: SupabaseClient, runId: string): RunBudget {
  return {
    runId,
    async claim(stage, wantUsd, minUsd) {
      const { data, error } = await db.rpc("run_budget_claim", { p_run_id: runId, p_stage: stage, p_want: wantUsd, p_min: minUsd });
      if (error) throw new Error(error.message);
      return data === null || data === undefined ? null : num(data);
    },
    async settle(stage, grantedUsd, actualUsd) {
      const { error } = await db.rpc("run_budget_settle", { p_run_id: runId, p_stage: stage, p_granted: grantedUsd, p_actual: actualUsd });
      if (error) throw new Error(error.message);
    },
    async room(stage) {
      const { data, error } = await db.rpc("run_budget_room", { p_run_id: runId, p_stage: stage });
      if (error || data === null || data === undefined) return null;
      return num(data);
    },
  };
}

/**
 * Open the run's budget, or keep the one it has: a run is claimed once, but a
 * retried worker must not hand itself a second dollar. Null when the row
 * cannot be written (a database without migration 106): the run then goes
 * ahead unbounded, and says so in the log, rather than buying nothing.
 */
export async function openRunBudget(
  db: SupabaseClient,
  run: { runId: string; workspaceId: string | null },
  opts: { ceilingUsd?: number; reserves?: Partial<Record<SpendStage, number>> } = {},
): Promise<RunBudget | null> {
  const { error } = await db.from("run_budgets").upsert(
    {
      run_id: run.runId,
      workspace_id: run.workspaceId,
      ceiling_usd: opts.ceilingUsd ?? firstLookCeiling(),
      reserves: opts.reserves ?? firstLookReserves(),
    },
    { onConflict: "run_id", ignoreDuplicates: true },
  );
  if (error) {
    console.error(`[spend] first-look budget unavailable for run ${run.runId}, the run is not bounded: ${error.message}`);
    return null;
  }
  return runBudget(db, run.runId);
}

/** The run's budget when it has one: the draft route's way back to the worker's. */
export async function loadRunBudget(db: SupabaseClient, runId: string): Promise<RunBudget | null> {
  const { data, error } = await db.from("run_budgets").select("run_id").eq("run_id", runId).maybeSingle();
  if (error || !data) return null;
  return runBudget(db, runId);
}

/** The row, for the funnel event. Null when it cannot be read. */
export async function readRunBudget(db: SupabaseClient, runId: string): Promise<RunBudgetState | null> {
  const { data, error } = await db.from("run_budgets").select("ceiling_usd, committed_usd, refused, stages").eq("run_id", runId).maybeSingle();
  if (error || !data) return null;
  const row = data as { ceiling_usd: unknown; committed_usd: unknown; refused: unknown; stages: unknown };
  const stages: RunBudgetState["stages"] = {};
  if (row.stages && typeof row.stages === "object") {
    for (const [stage, v] of Object.entries(row.stages as Record<string, Record<string, unknown>>)) {
      stages[stage as SpendStage] = {
        committed: round(num(v?.committed)),
        spent: round(num(v?.spent)),
        calls: num(v?.calls),
        refused: num(v?.refused),
      };
    }
  }
  return { ceilingUsd: num(row.ceiling_usd), committedUsd: round(num(row.committed_usd)), refused: num(row.refused), stages };
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
