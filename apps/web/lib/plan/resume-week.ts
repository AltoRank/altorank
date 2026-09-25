// ---------------------------------------------------------------------------
// The trial starts: open the month, and write the rest of this week now
// ---------------------------------------------------------------------------
//
// Mike's flow, decided 2026-09-25: onboarding writes one article; the rest of
// that week is held until the seven-day trial starts (lib/billing/trial-hold.ts);
// the moment it does, the rest of the week is drafted straight away, so the
// dashboard fills while the person looks around, and the rest of the month
// stays on the calendar for the scheduled writer at the site's pace.
//
// Until this file the trial start topped the calendar up from inside the
// Stripe webhook - minutes of paid qualification inside a request Stripe
// times out and retries - and then nothing was written until the next 07:00
// run. The webhook now answers Stripe at once and hands this to its own
// invocation (/api/internal/resume-drafting), mirroring how /api/onboard/start
// hands the first look to /api/onboard/run.
//
// The shape of it:
//
//   1. once per site per checkout: `workspaces.trial_resume_key` is claimed
//      with one conditional update (migration 093), so a redelivered or
//      duplicated Stripe event does the month and the week once
//   2. the month: `schedulePlan` top-up, as the webhook did
//   3. the week: the entries dated from today to the end of the plan's
//      current week are claimed one by one (lib/plan/draft-claim.ts) and each
//      is sent to /api/internal/draft in its own invocation
//
// Bounded three ways. The week's pace, from the same budget the scheduled
// writer spends (lib/plan/pace-budget.ts), so the burst and the cron cannot
// both spend the week. The spend gate (`canSpend`), so a paused account is
// not drafted for because it happened to start a trial. And
// RESUME_MAX_IN_FLIGHT drafts at a time: when one lands, its draft route asks
// this file for the next (`continueFrom`), so the week is written as fast as
// six at once allows rather than as a spike of fourteen model calls.
//
// Nothing is lost when something breaks. An entry this never claimed is still
// queued, and cron/generate writes it on its day. An entry whose draft failed
// records the failure on the calendar and is due to the next scheduled run
// whatever its date; one whose writer died is too, once its claim's lease runs
// out (lib/onboarding/plan.ts, `duePlannedKeyword`).

import type { SupabaseClient } from "@supabase/supabase-js";
import { canSpend } from "@/lib/billing/spend-gate";
import { readPaceBudget } from "@/lib/plan/pace-budget";
import { readFrozenEntries } from "@/lib/plan/frozen";
import { schedulePlan } from "@/lib/onboarding/plan";
import { claimEntry, claimsInFlight, recordEntryFailure, recordUnclaimedFailure } from "@/lib/plan/draft-claim";
import { MAX_FAN_OUT, selfInvocation, selfInvoke, type SelfInvokeDeps } from "@/lib/content/fan-out";
import { FREE_TIER_PACE, PAID_DEFAULT_PACE } from "@/lib/content/pace";
import { recordEvent } from "@/lib/observability/record";

const DAY_MS = 86_400_000;

/**
 * Drafts one site has in flight at once. The fan-out's own ceiling, for the
 * fan-out's reason: thirty concurrent model calls is a spike at the provider
 * rather than a feature (lib/content/fan-out.ts).
 */
export const RESUME_MAX_IN_FLIGHT = MAX_FAN_OUT;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The plan's week that contains `today`, from today to its last day.
 *
 * The planner lays a site's month out in seven-day windows from the day the
 * plan starts (`buildPlan`), and the first of those windows is the week the
 * person was shown at signup: the one article, and the topics the trial would
 * open behind it. So the weeks here are counted from the site's earliest
 * calendar entry, and "the rest of this week" is today through the end of the
 * window today falls in. A trial started the day after signup finishes the
 * week the person saw; one started a month later finishes that month's week.
 * With no entry to count from, the week starts today.
 *
 * Dates are the planner's: UTC calendar days, as `scheduled_date` is written
 * by the planner and read by cron/generate. A site's only timezone is its
 * publishing cadence's, which says when an approved article goes out, not
 * which day an entry is planned for; counting the week in it would move the
 * boundary a day away from the dates the planner wrote. Pure.
 */
export function planWeekContaining(anchor: string | null, today: Date): { from: string; until: string } {
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const a = anchor ? Date.parse(`${anchor}T00:00:00Z`) : Number.NaN;
  const base = Number.isNaN(a) || a > t ? t : a;
  const start = base + Math.floor((t - base) / (7 * DAY_MS)) * 7 * DAY_MS;
  return { from: isoDate(t), until: isoDate(start + 6 * DAY_MS) };
}

/** How many drafts may start now. Pure, so the three bounds can be tested together. */
export function draftsToStart(input: {
  /** Unclaimed entries left in the week. */
  waiting: number;
  /** `readPaceBudget(...).articlesLeft`. */
  articlesLeft: number;
  /** Claims whose writer is still inside its lease. */
  inFlight: number;
  /** Autonomous drafts of this site in `drafting`. */
  draftingRows: number;
}): number {
  // A claimed draft is in the pace budget only once its row exists, so the
  // claims that have no row yet are taken off the budget here. Claims that
  // do have one are already counted in `articlesLeft`.
  const unseen = Math.max(0, input.inFlight - input.draftingRows);
  const byPace = input.articlesLeft - unseen;
  const byConcurrency = RESUME_MAX_IN_FLIGHT - input.inFlight;
  return Math.max(0, Math.min(input.waiting, byPace, byConcurrency));
}

export interface ResumeSite {
  id: string;
  account_id: string;
  auto_generate?: boolean | null;
  status?: string | null;
  auto_generate_weekly_limit?: number | null;
  refresh_enabled?: boolean | null;
  refresh_days?: number[] | null;
}

export const RESUME_SITE_COLUMNS =
  "id, account_id, auto_generate, status, auto_generate_weekly_limit, refresh_enabled, refresh_days";

export interface WeekOutcome {
  workspaceId: string;
  /** The window drafted, when one was worked out. */
  week: { from: string; until: string } | null;
  /** Entry ids claimed and sent in this pass. */
  started: string[];
  /** Unclaimed entries still in the week after this pass. */
  waiting: number;
  /** Claims still being written, including this pass's. */
  inFlight: number;
  /** Set when the spend gate refused; also written on the entries. */
  refused?: string;
  detail: string;
  /** Settles once every request this pass sent has answered. Never rejects. */
  settled: Promise<void>;
}

export interface WeekDeps extends SelfInvokeDeps {
  now?: Date;
  canSpend?: typeof canSpend;
}

type Entry = { id: string; keyword_id: string | null; keyword: string | null; scheduled_date: string };

/**
 * Claim and send the next drafts of this site's week, as many as the three
 * bounds allow. The first call is the resume; every draft that lands calls
 * it again (`continueFrom`) with the same writer and the same week, and it
 * starts the next one.
 *
 * `by` names the writer on every claim, so the draft route can check that the
 * request it holds is the one that won, and a second delivery - a different
 * pass with the same `by`, or a different event - finds the entries taken.
 * `until`, when given, pins the week the resume started, so a chain that runs
 * past midnight at the end of it does not wander into the next one.
 */
export async function draftRestOfWeek(
  supabase: SupabaseClient,
  site: ResumeSite,
  opts: { by: string; until?: string } & WeekDeps,
): Promise<WeekOutcome> {
  const now = opts.now ?? new Date();
  const out: WeekOutcome = {
    workspaceId: site.id,
    week: null,
    started: [],
    waiting: 0,
    inFlight: 0,
    detail: "",
    settled: Promise.resolve(),
  };

  // The scheduled writer's own opt-in and pause: a site nobody asked to be
  // written for, or one paused by hand, is not written for here either.
  if (!site.auto_generate) return { ...out, detail: "automatic drafting is off for this site" };
  if (site.status === "paused") return { ...out, detail: "the site is paused" };

  const { data: first, error: firstError } = await supabase
    .from("calendar_entries")
    .select("scheduled_date")
    .eq("workspace_id", site.id)
    .in("status", ["queue", "scheduled"])
    .order("scheduled_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (firstError) throw new Error(`could not read the plan: ${firstError.message}`);
  const computed = planWeekContaining((first?.scheduled_date as string | undefined) ?? null, now);
  const week = { from: computed.from, until: opts.until ?? computed.until };
  out.week = week;
  if (week.until < week.from) return { ...out, detail: "the week this resume started has ended" };

  const { data: rows, error } = await supabase
    .from("calendar_entries")
    .select("id, keyword_id, keyword, scheduled_date")
    .eq("workspace_id", site.id)
    .eq("status", "queue")
    .is("article_id", null)
    .is("draft_claimed_at", null)
    .gte("scheduled_date", week.from)
    .lte("scheduled_date", week.until)
    .order("scheduled_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`could not read this week's plan: ${error.message}`);
  let waiting = ((rows ?? []) as Entry[]).filter((e) => e.keyword);
  out.inFlight = await claimsInFlight(supabase, site.id, now);
  out.waiting = waiting.length;
  if (!waiting.length) return { ...out, detail: "nothing left to draft this week" };

  // The spend gate, as the scheduled writer asks it: nobody's session. A
  // refusal is written on the entries, where the calendar shows it; they stay
  // unclaimed, and the scheduled writer - which asks the same gate - takes
  // them when it opens.
  const gate = await (opts.canSpend ?? canSpend)(supabase, site.account_id, {
    userEmail: null,
    workspaceId: site.id,
    action: "scheduled-work",
  });
  if (!gate.allowed) {
    await recordUnclaimedFailure(supabase, waiting.map((e) => e.id), gate.message, now);
    await recordEvent(
      {
        level: "warn",
        source: "plan.resume",
        message: `The rest of the week was not drafted: ${gate.message}`,
        accountId: site.account_id,
        workspaceId: site.id,
        context: { entries: waiting.length, by: opts.by },
      },
      supabase,
    );
    return { ...out, refused: gate.message, detail: `refused: ${gate.message}` };
  }

  // Entries past what the plan can pay for are the calendar's "inactive"
  // ones (lib/plan/frozen.ts); the scheduled writer skips them, and so does
  // this.
  const frozen = await readFrozenEntries(supabase, site.id, gate.quota);
  waiting = waiting.filter((e) => !frozen.ids.has(e.id));

  const how = selfInvocation(opts);
  if ("skipped" in how) {
    // No way to reach our own draft route (no CRON_SECRET or no base URL):
    // nothing is claimed, so the scheduled writer writes each entry on its day.
    return { ...out, detail: `left for the scheduled writer: this install cannot call itself (${how.skipped})` };
  }

  const budget = await readPaceBudget(supabase, site.id, {
    weeklyLimit: site.auto_generate_weekly_limit ?? PAID_DEFAULT_PACE,
    refreshEnabled: Boolean(site.refresh_enabled),
    refreshDays: site.refresh_days ?? null,
    now,
  });
  const { count: draftingRows, error: draftingError } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", site.id)
    .eq("generated_autonomously", true)
    .eq("status", "drafting");
  if (draftingError) throw new Error(`could not count the drafts being written: ${draftingError.message}`);

  const room = draftsToStart({
    waiting: waiting.length,
    articlesLeft: budget.articlesLeft,
    inFlight: out.inFlight,
    draftingRows: draftingRows ?? 0,
  });
  if (room === 0) {
    return {
      ...out,
      detail:
        budget.articlesLeft <= 0
          ? "this week's pace is spent; the rest waits for the scheduled writer"
          : `${out.inFlight} already being written; the next starts when one lands`,
    };
  }

  const started: Entry[] = [];
  for (const entry of waiting) {
    if (started.length >= room) break;
    if (await claimEntry(supabase, entry.id, opts.by, { fresh: true, now })) started.push(entry);
  }

  const requests = started.map((entry) =>
    selfInvoke(
      "/api/internal/draft",
      {
        workspaceId: site.id,
        entryId: entry.id,
        keywordId: entry.keyword_id,
        keyword: entry.keyword,
        claim: opts.by,
        until: week.until,
      },
      how,
    ).then(
      async (res) => {
        // The route records its own failures once it is running, in the
        // writer's words, and those stand. A request it never ran - refused,
        // or cut off by the platform - is recorded here, so the entry is
        // handed back now rather than when its lease runs out.
        if (!res.ok) {
          await recordEntryFailure(supabase, entry.id, opts.by, `The draft could not be started (${res.status}).`, new Date(), { ifUnrecorded: true });
        }
      },
      async (err: unknown) => {
        await recordEntryFailure(
          supabase,
          entry.id,
          opts.by,
          `The draft could not be started: ${err instanceof Error ? err.message : String(err)}`,
          new Date(),
          { ifUnrecorded: true },
        );
      },
    ),
  );

  return {
    ...out,
    started: started.map((e) => e.id),
    waiting: waiting.length - started.length,
    inFlight: out.inFlight + started.length,
    detail: `started ${started.length} of ${waiting.length} left this week`,
    settled: Promise.all(requests).then(() => undefined),
  };
}

export interface SiteResume {
  workspaceId: string;
  /** The month top-up: entries added, or why it did not run. */
  topUp: number | string;
  week?: Omit<WeekOutcome, "settled">;
  skipped?: string;
}

export interface AccountResume {
  accountId: string;
  sites: SiteResume[];
  /** Settles once every draft request sent has answered. Never rejects. */
  settled: Promise<void>;
}

/**
 * Everything a checkout opens, for every site of the account, once per
 * checkout (`key`, the Stripe subscription id).
 *
 * `draftWeek` is true when the checkout started a trial: that is the moment
 * the hold lifts. A checkout without one keeps what it always did - the month
 * topped up, drafting at the scheduled writer's pace.
 */
export async function resumeAccount(
  supabase: SupabaseClient,
  accountId: string,
  opts: { key: string; draftWeek: boolean } & WeekDeps,
): Promise<AccountResume> {
  const now = opts.now ?? new Date();
  const { data, error } = await supabase
    .from("workspaces")
    .select(`${RESUME_SITE_COLUMNS}, publishing_cadences(days_of_week, enabled)`)
    .eq("account_id", accountId);
  if (error) throw new Error(`could not read the account's sites: ${error.message}`);

  const sites: SiteResume[] = [];
  const pending: Promise<void>[] = [];
  for (const row of (data ?? []) as Array<ResumeSite & { publishing_cadences?: unknown }>) {
    // Claim the site for this checkout. One conditional update; a second
    // delivery of the event, or a second event for the same checkout, finds
    // it taken and does nothing - neither a second top-up (two concurrent
    // top-ups both read the same room and both insert) nor a second week.
    const { data: claimed, error: claimError } = await supabase
      .from("workspaces")
      .update({ trial_resume_key: opts.key, trial_resumed_at: now.toISOString() })
      .eq("id", row.id)
      .or(`trial_resume_key.is.null,trial_resume_key.neq.${opts.key}`)
      .select("id");
    if (claimError) {
      sites.push({ workspaceId: row.id, topUp: `not run: ${claimError.message}`, skipped: "could not claim the site" });
      continue;
    }
    if (!(claimed ?? []).length) {
      sites.push({ workspaceId: row.id, topUp: "already done for this checkout", skipped: "already resumed for this checkout" });
      continue;
    }

    // The month. Best effort per site, as it was in the webhook: the nightly
    // top-up runs the same thing, so a failure here costs a day, not the plan.
    let topUp: number | string;
    try {
      const cadence = row.publishing_cadences as { days_of_week: number[]; enabled: boolean } | { days_of_week: number[]; enabled: boolean }[] | null | undefined;
      const c = Array.isArray(cadence) ? cadence[0] : cadence;
      const daysOfWeek = c?.enabled && c.days_of_week?.length ? c.days_of_week : undefined;
      const added = await schedulePlan(supabase, row.id, row.auto_generate_weekly_limit ?? FREE_TIER_PACE, { mode: "top-up", daysOfWeek });
      topUp = added.length;
    } catch (err) {
      topUp = `failed: ${err instanceof Error ? err.message : String(err)}`;
      await recordEvent(
        { level: "warn", source: "plan.resume", message: `The month top-up failed at checkout: ${topUp}`, accountId, workspaceId: row.id },
        supabase,
      );
    }

    if (!opts.draftWeek) {
      sites.push({ workspaceId: row.id, topUp });
      continue;
    }
    try {
      const week = await draftRestOfWeek(supabase, row, { ...opts, by: `trial:${opts.key}`, now });
      pending.push(week.settled);
      const { settled: _settled, ...report } = week;
      void _settled;
      sites.push({ workspaceId: row.id, topUp, week: report });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordEvent(
        { level: "warn", source: "plan.resume", message: `The rest of the week could not be started: ${reason}`, accountId, workspaceId: row.id },
        supabase,
      );
      sites.push({ workspaceId: row.id, topUp, skipped: `week not started: ${reason}` });
    }
  }
  return { accountId, sites, settled: Promise.all(pending).then(() => undefined) };
}

/**
 * The next draft of a resumed week, after one has landed. Called by the draft
 * route with the claim it just finished, so the chain keeps RESUME_MAX_IN_FLIGHT
 * drafts going until the week is written or a bound stops it. `done` is true
 * when nothing is left in flight and nothing more was started: the moment the
 * batch is over and worth one email.
 */
export async function continueFrom(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { by: string; until?: string } & WeekDeps,
): Promise<{ started: number; done: boolean; settled: Promise<void>; detail: string }> {
  const { data, error } = await supabase.from("workspaces").select(RESUME_SITE_COLUMNS).eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(`could not read the site: ${error.message}`);
  if (!data) return { started: 0, done: true, settled: Promise.resolve(), detail: "the site no longer exists" };
  const week = await draftRestOfWeek(supabase, data as ResumeSite, opts);
  return {
    started: week.started.length,
    done: week.inFlight === 0,
    settled: week.settled,
    detail: week.detail,
  };
}
