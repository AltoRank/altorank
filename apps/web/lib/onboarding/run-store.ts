// ---------------------------------------------------------------------------
// Reading and writing onboarding_runs
// ---------------------------------------------------------------------------
//
// Every write to the row goes through here, with the service client: the
// start route inserts, the worker records each event, the draft route stamps
// the draft. The screen never writes. Reads come from wherever the caller's
// client is - /state and the wizard page read through the user's client, so
// the RLS policy from 076 is what decides who sees a run.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  initialOnboardingState,
  isRunStale,
  reduceOnboarding,
  runStatusFrom,
  STALE_RUN_ERROR,
  type OnboardingArticle,
  type OnboardingEvent,
  type OnboardingRunArticle,
  type OnboardingRunRow,
  type OnboardingRunSnapshot,
  type OnboardingState,
} from "./events";

export const RUN_COLUMNS =
  "id, workspace_id, status, phases, planned, keywords_found, article_id, error, started_at, updated_at, finished_at";

const ARTICLE_COLUMNS = "id, title, keyword, word_count, fact_check_verdict, status";

/** The most recent run for a workspace, with its draft, as /state answers it. */
export async function latestRun(
  supabase: SupabaseClient,
  workspaceId: string,
  now = Date.now(),
): Promise<OnboardingRunSnapshot> {
  const { data } = await supabase
    .from("onboarding_runs")
    .select(RUN_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const run = (data as OnboardingRunRow | null) ?? null;
  if (!run) return { run: null, article: null, stale: false };

  let article: OnboardingRunArticle | null = null;
  if (run.article_id) {
    const { data: row } = await supabase.from("articles").select(ARTICLE_COLUMNS).eq("id", run.article_id).maybeSingle();
    article = (row as OnboardingRunArticle | null) ?? null;
  }
  return { run, article, stale: isRunStale(run, now) };
}

/**
 * The run to show for a workspace: the live one if there is one, else a new
 * row. Idempotent by the partial unique index in 076 - a second start while
 * one is running returns the first's id and creates nothing, so the screen
 * can call it on every mount without doubling the crawl.
 *
 * A `running` row nothing has written to for RUN_STALE_MS is a worker that
 * died (the function was cut off, the dispatch never landed). It is closed as
 * an error, with the reason, and a fresh run begins: the phases it finished
 * persisted on their own tables, so the new run's early phases are cheap.
 */
export async function startRun(
  supabase: SupabaseClient,
  workspace: { id: string; agency_id: string },
  now = Date.now(),
): Promise<{ runId: string; created: boolean }> {
  const live = async () => {
    const { data } = await supabase
      .from("onboarding_runs")
      .select("id, status, updated_at")
      .eq("workspace_id", workspace.id)
      .eq("status", "running")
      .maybeSingle();
    return (data as Pick<OnboardingRunRow, "id" | "status" | "updated_at"> | null) ?? null;
  };

  const existing = await live();
  if (existing) {
    if (!isRunStale(existing, now)) return { runId: existing.id, created: false };
    await supabase
      .from("onboarding_runs")
      .update({ status: "error", error: STALE_RUN_ERROR, finished_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() })
      .eq("id", existing.id)
      .eq("status", "running");
  }

  const { data, error } = await supabase
    .from("onboarding_runs")
    .insert({ workspace_id: workspace.id, agency_id: workspace.agency_id })
    .select("id")
    .single();
  if (data) return { runId: (data as { id: string }).id, created: true };
  // Two starts raced; the index let one through. Return that one.
  if (error?.code === "23505") {
    const winner = await live();
    if (winner) return { runId: winner.id, created: false };
  }
  throw new Error(`Could not start the run: ${error?.message ?? "no row returned"}`);
}

/**
 * The worker's view of the row: fold every event into state and write the
 * state down, in order, without making the pipeline wait.
 *
 * `record` is synchronous because `Emit` is: the pipeline calls it at a phase
 * boundary and moves on. Writes are chained so they land in the order the
 * events happened, and `flush` is awaited before the run is finished or the
 * draft dispatched, so the draft route can never be stamping a row the
 * worker still has a write queued for.
 *
 * A write that fails is logged and the run carries on: the work itself is
 * persisted on its own tables, and a row that goes quiet is reported as
 * stale by the screen rather than as a phase that failed.
 */
export class RunRecorder {
  state: OnboardingState = initialOnboardingState();
  private queue: Promise<void> = Promise.resolve();
  /** How many writes reached the row; for tests, and the log line. */
  writes = 0;

  constructor(
    private readonly supabase: SupabaseClient,
    readonly runId: string,
  ) {}

  record = (event: OnboardingEvent): void => {
    this.state = reduceOnboarding(this.state, event);
    const snapshot = this.state;
    this.queue = this.queue.then(() => this.write(snapshot));
  };

  private async write(state: OnboardingState): Promise<void> {
    const { error } = await this.supabase
      .from("onboarding_runs")
      .update({
        phases: state.steps,
        planned: state.planned,
        keywords_found: state.keywordsFound,
        ...(state.article ? { article_id: state.article.id } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", this.runId);
    if (error) console.error(`[onboarding] run ${this.runId}: could not persist phases: ${error.message}`);
    else this.writes += 1;
  }

  /** Wait for every queued write. */
  flush(): Promise<void> {
    return this.queue;
  }

  /** The run is over and nothing else will write to it. */
  async finish(): Promise<void> {
    await this.flush();
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from("onboarding_runs")
      .update({ status: runStatusFrom(this.state), finished_at: now, updated_at: now })
      .eq("id", this.runId)
      .eq("status", "running");
    if (error) console.error(`[onboarding] run ${this.runId}: could not finish: ${error.message}`);
  }

  /** The worker itself threw. Everything recorded so far stays on the row. */
  async fail(reason: string): Promise<void> {
    await this.flush();
    await failRun(this.supabase, this.runId, reason);
  }
}

/** Close a run as `error`, if it is still running. */
export async function failRun(supabase: SupabaseClient, runId: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("onboarding_runs")
    .update({ status: "error", error: reason, finished_at: now, updated_at: now })
    .eq("id", runId)
    .eq("status", "running");
  if (error) console.error(`[onboarding] run ${runId}: could not mark error: ${error.message}`);
}

/**
 * Fold one more event into a run from outside the worker - the draft route,
 * writing the draft in its own invocation after the worker has returned.
 *
 * Read-modify-write on the row's own `phases`, so it composes with whatever
 * the worker left there. A row that has already left `running` is not touched
 * and the call says so: the run was closed as stale, or by a competing write,
 * and a late stamp must not reopen it. With `finish`, the status is settled
 * from the row (planned, the draft) and `finished_at` set.
 */
export async function stampRun(
  supabase: SupabaseClient,
  runId: string,
  event: OnboardingEvent,
  opts: { article?: OnboardingArticle | null; finish?: boolean } = {},
): Promise<boolean> {
  const { data } = await supabase.from("onboarding_runs").select(RUN_COLUMNS).eq("id", runId).maybeSingle();
  const run = data as OnboardingRunRow | null;
  if (!run || run.status !== "running") return false;

  const before: OnboardingState = {
    ...initialOnboardingState(),
    steps: run.phases,
    planned: run.planned ?? [],
    keywordsFound: run.keywords_found,
    article: opts.article ?? null,
    error: run.error,
  };
  const state = reduceOnboarding(before, event);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    phases: state.steps,
    planned: state.planned,
    keywords_found: state.keywordsFound,
    updated_at: now,
  };
  if (opts.article) patch.article_id = opts.article.id;
  if (opts.finish) {
    patch.status = runStatusFrom({
      planned: state.planned,
      article: opts.article ?? (run.article_id ? ({ id: run.article_id } as OnboardingArticle) : null),
      error: state.error,
    });
    patch.finished_at = now;
  }
  const { error } = await supabase.from("onboarding_runs").update(patch).eq("id", runId).eq("status", "running");
  if (error) {
    console.error(`[onboarding] run ${runId}: could not stamp ${event.phase}: ${error.message}`);
    return false;
  }
  return true;
}
