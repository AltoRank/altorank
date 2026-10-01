// ---------------------------------------------------------------------------
// Whose spend a call is, and whether it may be made: carried by the call
// ---------------------------------------------------------------------------
//
// Spend used to be attributed through one process-global callback
// (lib/seo/client.ts `setSpendReporter`): the caller armed it with its
// workspace, did the work, and cleared it. Two pieces of work in one process -
// an onboarding run and a cron, or two runs on one warm instance - each armed
// it over the other, and every call billed whichever armed it last. Found
// 2026-09-28; an earlier first look closed at $1.13 that nothing could
// attribute.
//
// So the attribution travels with the work instead, in AsyncLocalStorage: a
// scope opened with `withSpendScope` is what every call made inside it - and
// inside anything it awaits - sees, and nothing outside it does. Scopes nest;
// an inner one inherits what it does not set.
//
// A scope may also carry a budget (lib/billing/run-budget.ts): a first look's
// dollar, kept in the database because the draft is written in another
// invocation. Every paid call claims its estimate from the budget before it
// is made (`claimSpend`) and settles it with what the provider charged after.
// A refused claim throws `BudgetRefusedError` and buys nothing; the caller
// leaves that item not judged, or the draft not written, and goes on.
//
// No budget in the scope, or no scope at all, and a claim is granted at once
// without a database read: the nightly crons, the editor and the scripts are
// bounded by their own gates, not by this.

import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The stages of a first look, as provider_spend.stage and the run budget's
 * per-stage split name them. `outline_swap` is reserved for the founder gate's
 * one topic swap; nothing claims it yet. `other` is a call made under a
 * budget that no stage named: a gap in the tagging, visible as such.
 */
export const SPEND_STAGES = [
  "voice",
  "profile",
  "discovery",
  "buyer_fit",
  "results_pages",
  "judge",
  "related_keywords",
  "draft",
  "outline_swap",
  "other",
] as const;
export type SpendStage = (typeof SPEND_STAGES)[number];

/** A run's budget, as a claim sees it. lib/billing/run-budget.ts keeps it in the database. */
export interface RunBudget {
  /** The onboarding run the budget belongs to; every spend row under it carries this id. */
  readonly runId: string;
  /** Grant up to `wantUsd`, never less than `minUsd`; null when refused. */
  claim(stage: SpendStage, wantUsd: number, minUsd: number): Promise<number | null>;
  /** Replace a grant with what was charged (null: the provider reported no price, keep the grant). */
  settle(stage: SpendStage, grantedUsd: number, actualUsd: number | null): Promise<void>;
  /** What `stage` may still claim, or null when it cannot be read. */
  room(stage: SpendStage): Promise<number | null>;
}

export interface SpendScope {
  workspaceId: string | null;
  articleId: string | null;
  /** Groups the rows of one piece of work (a generation job). A budget's run id wins over it. */
  runId: string | null;
  stage: SpendStage | null;
  budget: RunBudget | null;
  /** Where spend rows are written. Null: the service-role client (lib/billing/default-spend.ts). */
  db: SupabaseClient | null;
  /** Claims refused inside this scope or any scope opened inside it. */
  refusals: number;
  readonly parent: SpendScope | null;
}

export type SpendScopePatch = Partial<Pick<SpendScope, "workspaceId" | "articleId" | "runId" | "stage" | "budget" | "db">>;

const storage = new AsyncLocalStorage<SpendScope>();

/** The scope the current call runs in, if any. */
export function currentSpendScope(): SpendScope | undefined {
  return storage.getStore();
}

/**
 * Run `fn` in a scope: the current one, with `patch` laid over it. The scope
 * object is handed to `fn`, which may fill in what it learns later (the
 * article id, once the row exists); calls made after that see it.
 */
export function withSpendScope<T>(patch: SpendScopePatch, fn: (scope: SpendScope) => T): T {
  const parent = storage.getStore() ?? null;
  const scope: SpendScope = {
    workspaceId: parent?.workspaceId ?? null,
    articleId: parent?.articleId ?? null,
    runId: parent?.runId ?? null,
    stage: parent?.stage ?? null,
    budget: parent?.budget ?? null,
    db: parent?.db ?? null,
    refusals: 0,
    parent,
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (scope as unknown as Record<string, unknown>)[key] = value;
  }
  return storage.run(scope, () => fn(scope));
}

/** Run `fn` with its spend tagged `stage`. */
export function withStage<T>(stage: SpendStage, fn: () => T): T {
  return withSpendScope({ stage }, () => fn());
}

/**
 * Run `fn` and say whether a claim was refused while it ran: the item it
 * worked on was then not judged, whatever `fn` returned. A refusal thrown out
 * of `fn` is thrown on.
 */
export async function watchRefusals<T>(fn: () => Promise<T>): Promise<{ value: T; refused: boolean }> {
  return withSpendScope({}, async (scope) => {
    const value = await fn();
    return { value, refused: scope.refusals > 0 };
  });
}

/** A paid call the budget would not cover. Nothing was bought. */
export class BudgetRefusedError extends Error {
  constructor(
    public readonly operation: string,
    public readonly stage: SpendStage | null,
    public readonly wantUsd: number,
  ) {
    super(`The first look's budget does not cover ${operation} (about $${wantUsd.toFixed(4)}${stage ? `, ${stage}` : ""}); not bought.`);
    this.name = "BudgetRefusedError";
  }
}

export function isBudgetRefusal(err: unknown): err is BudgetRefusedError {
  return err instanceof BudgetRefusedError;
}

export interface SpendClaim {
  /** What the call may cost: the estimate, or less when the claim asked for a range. */
  readonly grantedUsd: number;
  /** Replace the claim with what was charged. Once; later calls do nothing. Never throws. */
  settle(actualUsd: number | null): Promise<void>;
}

const UNBOUNDED: Omit<SpendClaim, "grantedUsd"> = { settle: async () => {} };

/**
 * Claim `wantUsd` for a paid call before making it. With `minUsd` the claim
 * takes what the budget has, down to that floor (the article writer sizes its
 * output to it). Throws `BudgetRefusedError` when the budget will not cover
 * it, or when the budget cannot be asked: a first look that cannot count its
 * spend does not spend.
 */
export async function claimSpend(operation: string, wantUsd: number, opts: { minUsd?: number } = {}): Promise<SpendClaim> {
  const scope = storage.getStore();
  const want = Math.max(0, Number.isFinite(wantUsd) ? wantUsd : 0);
  const budget = scope?.budget;
  if (!scope || !budget) return { grantedUsd: want, ...UNBOUNDED };
  const stage = scope.stage ?? "other";
  const min = Math.min(want, Math.max(0, opts.minUsd ?? want));
  let granted: number | null = null;
  try {
    granted = await budget.claim(stage, want, min);
  } catch (err) {
    console.error(`[spend] budget claim for ${operation} failed, refused: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (granted === null) {
    for (let s: SpendScope | null = scope; s; s = s.parent) s.refusals += 1;
    throw new BudgetRefusedError(operation, scope.stage, want);
  }
  let settled = false;
  const grantedUsd = granted;
  return {
    grantedUsd,
    settle: async (actualUsd) => {
      if (settled) return;
      settled = true;
      try {
        await budget.settle(stage, grantedUsd, actualUsd);
      } catch (err) {
        // The claim stays at its estimate, which is the conservative side.
        console.error(`[spend] budget settle for ${operation} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** The attribution a spend row takes from the scope it was made in. */
export function scopeAttribution(scope: SpendScope | undefined = storage.getStore()): {
  workspaceId: string | null;
  articleId: string | null;
  runId: string | null;
  stage: SpendStage | null;
} {
  return {
    workspaceId: scope?.workspaceId ?? null,
    articleId: scope?.articleId ?? null,
    runId: scope?.budget?.runId ?? scope?.runId ?? null,
    stage: scope?.stage ?? null,
  };
}
