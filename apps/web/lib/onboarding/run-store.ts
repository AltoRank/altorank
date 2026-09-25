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
import { recordEvent } from "@/lib/observability/record";
import { notifySetupFailed } from "@/lib/email/lifecycle";
import { loadFirstLookReport } from "./first-look-report";
import { heldTopics } from "./plan";
import { FREE_TIER_PACE } from "@/lib/content/pace";
import type { OnboardingHeld } from "./events";
import {
  initialOnboardingState,
  onboardingOutcome,
  isRunStale,
  RUN_STALE_MS,
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

/**
 * The same row plus the account it belongs to. Only the operational log wants
 * that column, and /state hands its row to the browser, so it stays out of
 * RUN_COLUMNS rather than being shipped to every polling screen.
 */
export const RUN_COLUMNS_WITH_AGENCY = `${RUN_COLUMNS}, account_id`;

const ARTICLE_COLUMNS = "id, title, keyword, word_count, fact_check_verdict, status";
/** The first draft plus the fan-out is eight at most; ten leaves room. */
const MAX_LISTED_DRAFTS = 10;

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
  // Everything the run wrote, for the trial step's list: the inline first
  // draft and the fan-out's, which the row never points at. Bounded by the
  // run's start so a second run on an old workspace does not list last
  // month's articles as this week's work.
  const { data: rows } = await supabase
    .from("articles")
    .select(ARTICLE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .gte("created_at", run.started_at)
    .order("created_at", { ascending: true })
    .limit(MAX_LISTED_DRAFTS);
  const drafts = (rows as OnboardingRunArticle[] | null) ?? [];
  // The audit the keywords phase wrote, when it has. Bounded by the run's
  // start for the same reason the drafts are.
  const report = await loadFirstLookReport(supabase, workspaceId, run.started_at);
  // What a trial would open. Read here, once the plan exists, so a screen
  // that shows the plan can show what stands behind it; a count is cheap.
  let held: OnboardingHeld | undefined;
  if ((run.planned ?? []).length) {
    try {
      const { data: ws } = await supabase.from("workspaces").select("auto_generate_weekly_limit").eq("id", workspaceId).maybeSingle();
      held = await heldTopics(supabase, workspaceId, (ws?.auto_generate_weekly_limit as number | null) ?? FREE_TIER_PACE, run.planned.map((p) => p.date));
    } catch {
      // Then the screen shows the plan without its locked rows.
    }
  }
  return { run, article, drafts, stale: isRunStale(run, now), report, ...(held ? { held } : {}) };
}

/** The live run, a new one, or the sentence that refused a new one. */
export type StartRunResult =
  | { runId: string; created: boolean; refused?: never }
  | { refused: string; runId?: never; created?: never };

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
 *
 * `mayCreate` is asked only when a new run would begin - never to hand back
 * the live one, which costs nothing - and a sentence from it refuses the new
 * run: `{ refused }`, nothing inserted. A new run buys the site read and the
 * keyword research again, so whether it may is the spend gate's question.
 */
export async function startRun(
  supabase: SupabaseClient,
  workspace: { id: string; account_id: string },
  now = Date.now(),
  opts: { mayCreate?: () => Promise<string | null> } = {},
): Promise<StartRunResult> {
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
    // Through the reaper, so a run closed here is recorded and announced the
    // same way one closed by the nightly pass is. This used to be a bare
    // update: the row went quiet, the row was closed, and nothing anywhere
    // said a first look had died.
    await reapStaleRuns(supabase, now, { runId: existing.id });
  }

  const refused = opts.mayCreate ? await opts.mayCreate() : null;
  if (refused) return { refused };

  const { data, error } = await supabase
    .from("onboarding_runs")
    .insert({ workspace_id: workspace.id, account_id: workspace.account_id })
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
    const status = runStatusFrom(this.state);
    const { data, error } = await this.supabase
      .from("onboarding_runs")
      .update({ status, finished_at: now, updated_at: now })
      .eq("id", this.runId)
      .eq("status", "running")
      .select("workspace_id, account_id");
    if (error) console.error(`[onboarding] run ${this.runId}: could not finish: ${error.message}`);
    else
      await announceOutcome(this.supabase, this.runId, status, scopeOf(data), this.state.steps, {
        produced: this.state.planned.length > 0 || this.state.article !== null,
      });
  }

  /** The worker itself threw. Everything recorded so far stays on the row. */
  async fail(reason: string): Promise<void> {
    await this.flush();
    await failRun(this.supabase, this.runId, reason);
  }
}

/** Close a run as `error`, if it is still running. */
export async function failRun(supabase: SupabaseClient, runId: string, reason: string): Promise<void> {
  await closeRun(supabase, runId, reason, null, false);
}

/**
 * Close a `running` row as an error, and say so where somebody will see it.
 *
 * `.eq("status", "running")` is the lock: two callers racing to close one row
 * (the reaper and a person reopening the screen) leave one update matching no
 * rows, and only the winner announces.
 */
async function closeRun(
  supabase: SupabaseClient,
  runId: string,
  reason: string,
  steps: readonly { phase: string; status: string; detail?: string | null }[] | null,
  produced: boolean,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("onboarding_runs")
    .update({ status: "error", error: reason, finished_at: now, updated_at: now })
    .eq("id", runId)
    .eq("status", "running")
    .select("workspace_id, account_id");
  if (error) {
    console.error(`[onboarding] run ${runId}: could not mark error: ${error.message}`);
    return false;
  }
  if (!(data ?? []).length) return false;
  await announceOutcome(supabase, runId, "error", scopeOf(data), steps, { reason, produced });
  return true;
}

/**
 * Close the runs whose worker died, wherever they are.
 *
 * A `running` row is reaped when the person comes back to the screen
 * (`startRun`), and only then. wesellanything.co's first look stopped at
 * 15:46 on 2026-09-08 and was still `running` thirteen days later: the person
 * closed the tab, so nothing ever read the row again. Nothing was emailed,
 * nothing was recorded, and the account sat in setup with a screen that would
 * have said "still working" if anyone had opened it.
 *
 * Called from the nightly pass rather than from a cron of its own: this
 * deployment's schedule is its cron budget, and a job that closes a handful of
 * rows does not need one.
 *
 * A run that produced a draft or a plan is closed just as quietly - the work
 * is on its own tables and the screen shows it - but the person is not
 * emailed about a setup that in fact delivered something (`announceOutcome`).
 */
export async function reapStaleRuns(
  supabase: SupabaseClient,
  now = Date.now(),
  opts: { limit?: number; runId?: string } = {},
): Promise<{ reaped: number; runIds: string[] }> {
  let query = supabase
    .from("onboarding_runs")
    .select("id, phases, planned, article_id, updated_at")
    .eq("status", "running")
    .lt("updated_at", new Date(now - RUN_STALE_MS).toISOString());
  // One row when the caller has one in hand; otherwise every stale row there
  // is, oldest first.
  if (opts.runId) query = query.eq("id", opts.runId);
  const { data, error } = await query.order("updated_at", { ascending: true }).limit(opts.limit ?? 50);
  if (error) {
    console.error(`[onboarding] stale runs could not be read: ${error.message}`);
    return { reaped: 0, runIds: [] };
  }
  const runIds: string[] = [];
  for (const row of (data ?? []) as Array<Pick<OnboardingRunRow, "id" | "phases" | "planned" | "article_id">>) {
    const produced = Boolean(row.article_id) || (row.planned ?? []).length > 0;
    if (await closeRun(supabase, row.id, STALE_RUN_ERROR, row.phases ?? null, produced)) runIds.push(row.id);
  }
  return { reaped: runIds.length, runIds };
}

/**
 * A run that ended anywhere but `done`, written where somebody will see it.
 *
 * This is the failure mode the product was actually bitten by. On 2026-09-07
 * the first real customer's setup stopped part-way; the row said `partial` and
 * the phases said which step, and the only reason anyone found out was a hand-
 * written query against production. Nothing was emailed, nothing was logged,
 * and the screen the customer had closed was the only place it had ever been
 * shown.
 *
 * `done` is not recorded. A successful first run is already visible as an
 * article, a calendar and a workspace that left `setup`; a row per success
 * would be noise in the one table that must stay readable.
 */
async function announceOutcome(
  supabase: SupabaseClient,
  runId: string,
  status: string,
  scope: { workspaceId: string | null; accountId: string | null },
  steps: readonly { phase: string; status: string; detail?: string | null }[] | null,
  opts: { reason?: string; produced: boolean },
): Promise<void> {
  if (status === "done" || status === "running") return;
  const reason = opts.reason;
  // Which phase fell short, which is the whole question an operator has.
  const failed = (steps ?? []).filter((s) => s.status === "failed" || s.status === "skipped");
  const where = failed.map((s) => `${s.phase}${s.detail ? `: ${s.detail}` : ""}`);
  await recordEvent(
    {
      level: status === "error" ? "error" : "warn",
      source: "onboarding.run",
      message:
        status === "error"
          ? `Onboarding failed: ${reason ?? where[0] ?? "no reason recorded"}`
          : `Onboarding finished ${status}: ${where[0] ?? "the phases do not say which step fell short"}`,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      context: { runId, status, phases: where },
    },
    supabase,
  );

  // The person, not just the operator. A run that made something the person
  // can open - a calendar, a draft - is not a failure to email about; the
  // run screen and the dashboard say what is missing. A run that made
  // nothing is, and until 2026-09-10 the only place it was ever said was the
  // screen the person had closed.
  if (opts.produced || !scope.workspaceId || !scope.accountId) return;
  try {
    const { data: ws } = await supabase.from("workspaces").select("domain").eq("id", scope.workspaceId).maybeSingle();
    const facts = setupFailedFacts(status, steps, reason);
    await notifySetupFailed(supabase, { accountId: scope.accountId, workspaceId: scope.workspaceId }, { domain: (ws?.domain as string | null) ?? null, ...facts });
  } catch (err) {
    // Never let the email take the run down with it: the row is already
    // final and the event above is already recorded.
    console.error(`[onboarding] run ${runId}: setup-failed email: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * What the email says, from what the run recorded. The sentence is the run
 * screen's own (`onboardingOutcome`), so the email, the banner and the
 * screen read the same words; `transient` is whether the crawl's reason is
 * one that clears on its own, in which case the next look is scheduled.
 */
export function setupFailedFacts(
  status: string,
  steps: readonly { phase: string; status: string; detail?: string | null }[] | null,
  reason?: string,
): { line: string; transient: boolean } {
  const state: OnboardingState = {
    ...initialOnboardingState(),
    steps: (steps ?? []).map((s) => ({ phase: s.phase as OnboardingState["steps"][number]["phase"], status: s.status as OnboardingState["steps"][number]["status"], ...(s.detail ? { detail: s.detail } : {}) })),
    ready: true,
    error: status === "error" ? (reason ?? "Onboarding failed.") : null,
  };
  const line = onboardingOutcome(state).line;
  // The pipeline writes this exact clause on the keywords phase when the
  // crawl failed for a reason that clears on its own (#191); reading the
  // phrase keeps this module off domain-analysis and its provider clients.
  const transient = status !== "error" && (steps ?? []).some((s) => /next look is already scheduled/i.test(s.detail ?? ""));
  return { line, transient };
}

/** The ids an `update(...).select(...)` handed back, if it handed back a row. */
function scopeOf(rows: unknown): { workspaceId: string | null; accountId: string | null } {
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  return {
    workspaceId: (row?.workspace_id as string | undefined) ?? null,
    accountId: (row?.account_id as string | undefined) ?? null,
  };
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
  const { data } = await supabase.from("onboarding_runs").select(RUN_COLUMNS_WITH_AGENCY).eq("id", runId).maybeSingle();
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
  // The draft route settles most runs, so this is where a `partial` usually
  // gets its final status. The ids come off the row we already read.
  if (opts.finish) {
    await announceOutcome(
      supabase,
      runId,
      String(patch.status),
      { workspaceId: run.workspace_id, accountId: (run as { account_id?: string }).account_id ?? null },
      state.steps,
      { produced: state.planned.length > 0 || Boolean(opts.article ?? run.article_id) },
    );
  }
  return true;
}
