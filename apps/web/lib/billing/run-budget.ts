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

// What the first draft is held, built from what the writer needs. The proof
// runs of 2026-10-01 showed the trap in a fixed $0.30: research spent to its
// line on every $1 run, the draft then bought its related keywords ($0.09)
// out of the $0.30, and the writer was sent with ~20,000 output tokens -
// under the 24,000 a Sonnet 5 run was cut off at (lib/ai/claude.ts). A
// cut-off draft is a failed draft whose cost is spent. So the reserve is the
// writer's floor plus its prompt and the draft's own research, at Sonnet 5's
// $10 a million output tokens (lib/billing/spend.ts), and the related-keyword
// lookup is bought only from room above that (`draftCanBuyLookup`): the
// writer's headroom comes first, the related keywords are a nicety.
//
// It is not bigger because research pays for it: a reserve that also held the
// lookup ($0.43) left research $0.52, and a proof run on it planned nothing.

/**
 * The least a budgeted writer is sent with (lib/ai/claude.ts): the worst
 * thinking run seen (~19,000 tokens) plus an article, above the 24,000 that
 * run was cut off at. Below it the claim is refused rather than a draft
 * started that is likely to be cut off.
 */
export const WRITER_MIN_OUTPUT_TOKENS = 28_000;
/** The writer's prompt as its claim estimates it: $0.0185 on the proof runs, held at $0.03. */
export const WRITER_PROMPT_USD = 0.03;
/** What the draft buys before the writer: its results page and the question pick ($0.005 on the proof runs). */
export const DRAFT_RESEARCH_USD = 0.02;
/** The draft's related-keyword lookup: one Google Ads `keywords_for_keywords` task on the live queue. */
export const RELATED_LOOKUP_USD = 0.09;
/** Sonnet 5's output rate, per token: the content tier the writer runs on. */
const WRITER_OUTPUT_USD_PER_TOKEN = 10 / 1_000_000;

/**
 * The least the draft stage must still be able to claim when a first draft
 * is started: the writer's floor, its prompt and the research before it.
 * Below it the research would be bought for a draft the writer cannot be
 * sent for.
 */
export const FIRST_DRAFT_MIN_USD = round2(DRAFT_RESEARCH_USD + WRITER_PROMPT_USD + WRITER_MIN_OUTPUT_TOKENS * WRITER_OUTPUT_USD_PER_TOKEN);
/** Held for the first draft: what it needs to be started, and no more. */
export const FIRST_LOOK_DRAFT_RESERVE_USD = FIRST_DRAFT_MIN_USD;
/**
 * Held for the founder gate's one outline swap before the trial. Zero until
 * the swap ships: nothing claims it yet, so holding money back would only
 * starve research. Set it (about 0.05) in the same change that builds the swap.
 */
export const FIRST_LOOK_SWAP_RESERVE_USD = 0;

/**
 * The ceiling a first look opens with. `FIRST_LOOK_BUDGET_USD` lowers it for
 * a proof run (a forced $0.50 shows the run stopping); it never raises it, and
 * a value that is not a positive number is ignored.
 */
export function firstLookCeiling(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FIRST_LOOK_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, FIRST_LOOK_CEILING_USD) : FIRST_LOOK_CEILING_USD;
}

/**
 * The reserves, in the proportion a lowered proof ceiling keeps: a forced
 * $0.50 holds half of each, so research still has something to buy and the
 * draft's pre-check is what stops the draft.
 */
export function firstLookReserves(ceilingUsd: number = FIRST_LOOK_CEILING_USD): Partial<Record<SpendStage, number>> {
  const scale = Math.min(1, Math.max(0, ceilingUsd / FIRST_LOOK_CEILING_USD));
  return { draft: round6(FIRST_LOOK_DRAFT_RESERVE_USD * scale), outline_swap: round6(FIRST_LOOK_SWAP_RESERVE_USD * scale) };
}

/**
 * Why the first draft cannot be written on what is left of the run's budget,
 * or null when it can (or the budget cannot be read: the claims decide then).
 */
export async function draftBudgetShort(budget: RunBudget | null): Promise<string | null> {
  if (!budget) return null;
  const room = await budget.room("draft").catch(() => null);
  if (room === null || room >= FIRST_DRAFT_MIN_USD) return null;
  return `This first look's budget has $${Math.max(0, room).toFixed(2)} left, and a first draft needs about $${FIRST_DRAFT_MIN_USD.toFixed(2)}. It was not started; a person picks the first article up.`;
}

/**
 * Whether the first draft's related-keyword lookup fits on top of what the
 * writer needs. True with no budget (everything outside a first look buys it
 * as before); false when the room cannot be read, so the writer keeps it.
 */
export async function draftCanBuyLookup(budget: RunBudget | null): Promise<boolean> {
  if (!budget) return true;
  const room = await budget.room("draft").catch(() => null);
  return room !== null && room >= FIRST_DRAFT_MIN_USD + RELATED_LOOKUP_USD;
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
 * Open the run's budget row, or keep the one it has: a run is claimed once,
 * but a retried worker must not hand itself a second dollar. Tried twice;
 * null when the row still cannot be written (a database without migration
 * 106, or a failing write). Callers do not run unbounded on null: see
 * `openFirstLookBudget`.
 */
export async function openRunBudget(
  db: SupabaseClient,
  run: { runId: string; workspaceId: string | null },
  opts: { ceilingUsd?: number; reserves?: Partial<Record<SpendStage, number>> } = {},
): Promise<RunBudget | null> {
  const ceilingUsd = opts.ceilingUsd ?? firstLookCeiling();
  const row = {
    run_id: run.runId,
    workspace_id: run.workspaceId,
    ceiling_usd: ceilingUsd,
    reserves: opts.reserves ?? firstLookReserves(ceilingUsd),
  };
  let message = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await Promise.resolve(db.from("run_budgets").upsert(row, { onConflict: "run_id", ignoreDuplicates: true }))
      .then((r) => r.error, (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }));
    if (!result) return runBudget(db, run.runId);
    message = result.message;
  }
  console.error(`[spend] first-look budget row for run ${run.runId} could not be written: ${message}`);
  return null;
}

/**
 * The worker's budget for a first look. The database row when it can be
 * opened; otherwise the same ceiling and reserves held in this process - the
 * research and the judging run in this one invocation, so they stay bounded
 * - and said loudly. Never unbounded: the after-the-fact check this replaced
 * was the only other bound, and it is gone.
 */
export async function openFirstLookBudget(
  db: SupabaseClient,
  run: { runId: string; workspaceId: string | null },
): Promise<{ budget: RunBudget; read: () => Promise<RunBudgetState | null> }> {
  const opened = await openRunBudget(db, run).catch(() => null);
  if (opened) return { budget: opened, read: () => readRunBudget(db, run.runId).catch(() => null) };
  console.error(`[spend] run ${run.runId}: the first look is bounded in memory instead; apply migration 106`);
  const ceilingUsd = firstLookCeiling();
  const memory = memoryRunBudget(run.runId, ceilingUsd, firstLookReserves(ceilingUsd));
  return { budget: memory, read: async () => memory.state() };
}

/** The run's budget row when it has one: the draft route's way back to the worker's. */
export async function loadRunBudget(db: SupabaseClient, runId: string): Promise<RunBudget | null> {
  const { data, error } = await db.from("run_budgets").select("run_id").eq("run_id", runId).maybeSingle();
  if (error || !data) return null;
  return runBudget(db, runId);
}

/**
 * The draft route's budget for an onboarding run's first draft: the row the
 * worker opened, or - when there is none to read (a database without
 * migration 106, a run the worker opened before this shipped) - the draft's
 * reserve alone, held in this invocation. Never unbounded.
 */
export async function loadDraftBudget(db: SupabaseClient, runId: string): Promise<RunBudget> {
  const loaded = await loadRunBudget(db, runId).catch(() => null);
  if (loaded) return loaded;
  console.error(`[spend] run ${runId}: no budget row for its first draft; the draft is held to its reserve in memory`);
  const reserve = firstLookReserves(firstLookCeiling()).draft ?? FIRST_LOOK_DRAFT_RESERVE_USD;
  return memoryRunBudget(runId, reserve, {});
}

/**
 * Migration 106's claim rules in this process: the fallback when the row
 * cannot be written or read. Claims are synchronous here, so concurrent ones
 * in one process take turns as the row lock makes them in the database.
 */
export function memoryRunBudget(
  runId: string,
  ceilingUsd: number,
  reserves: Partial<Record<SpendStage, number>>,
): RunBudget & { state(): RunBudgetState } {
  let committed = 0;
  let refused = 0;
  const stages: RunBudgetState["stages"] = {};
  const stageOf = (stage: SpendStage) => (stages[stage] ??= {});
  const room = (stage: SpendStage): number => {
    let held = 0;
    for (const [other, usd] of Object.entries(reserves) as Array<[SpendStage, number]>) {
      if (other !== stage) held += Math.max(0, usd - (stages[other]?.committed ?? 0));
    }
    return ceilingUsd - committed - held;
  };
  return {
    runId,
    async claim(stage, wantUsd, minUsd) {
      const grant = Math.min(wantUsd, room(stage));
      const s = stageOf(stage);
      if (grant < minUsd) {
        refused += 1;
        s.refused = (s.refused ?? 0) + 1;
        return null;
      }
      committed += grant;
      s.committed = (s.committed ?? 0) + grant;
      return grant;
    },
    async settle(stage, grantedUsd, actualUsd) {
      const spent = Math.max(0, actualUsd ?? grantedUsd);
      const s = stageOf(stage);
      committed += spent - grantedUsd;
      s.committed = (s.committed ?? 0) + spent - grantedUsd;
      s.spent = (s.spent ?? 0) + spent;
      s.calls = (s.calls ?? 0) + 1;
    },
    async room(stage) {
      return room(stage);
    },
    state() {
      const copy: RunBudgetState["stages"] = {};
      for (const [stage, v] of Object.entries(stages)) {
        copy[stage as SpendStage] = { committed: round6(v?.committed ?? 0), spent: round6(v?.spent ?? 0), calls: v?.calls ?? 0, refused: v?.refused ?? 0 };
      }
      return { ceilingUsd, committedUsd: round6(committed), refused, stages: copy };
    },
  };
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
        committed: round6(num(v?.committed)),
        spent: round6(num(v?.spent)),
        calls: num(v?.calls),
        refused: num(v?.refused),
      };
    }
  }
  return { ceilingUsd: num(row.ceiling_usd), committedUsd: round6(num(row.committed_usd)), refused: num(row.refused), stages };
}

function round6(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

function round2(usd: number): number {
  return Math.round(usd * 100) / 100;
}
