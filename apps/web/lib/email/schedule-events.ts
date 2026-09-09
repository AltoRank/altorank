// ---------------------------------------------------------------------------
// The two things the schedule has to say out loud
// ---------------------------------------------------------------------------
//
// Both run from the generate cron, which is the only job that touches every
// account on every run and therefore the only place either of these can be
// noticed at all.
//
//   a pause about to end   Stripe resumes collection on the date by itself.
//                          A customer who paused for three months and forgot
//                          would learn about it from a charge.
//   nothing being written  the cron records "skipped" in its JSON body and
//                          moves on, so a site whose keyword queue has run dry
//                          simply stops appearing on the calendar. Every reason
//                          here is fixable by the customer in about a minute.
//
// Neither can fail the run: the first is a reminder, the second is about work
// that did not happen.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isoDay } from "@/lib/billing/resume";
import { profileIsUsable, type TopicalProfile } from "@/lib/seo/topical-profile";
import {
  notifyNothingWritten,
  notifyPauseEnding,
  notifySetupUnfinished,
  type NothingWrittenReason,
  type SetupUnfinishedEmail,
} from "./lifecycle";
import { describeSendOutcome } from "./send-once";

/** How long before a pause lifts the reminder goes out. */
export const PAUSE_REMINDER_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export type PauseReminderOutcome = { accountId: string; pausedUntil: string; emailed: string };

/**
 * Remind every account whose pause lifts within the next few days.
 *
 * The window is a range, not a single day, so a cron that misses a run - or a
 * deployment that skips one - does not skip the reminder with it. `sendOnce`
 * is keyed by (account, pause date), which is what stops four daily runs inside
 * that window from sending four emails.
 */
export async function remindEndingPauses(
  supabase: SupabaseClient,
  today: Date = new Date(),
): Promise<PauseReminderOutcome[]> {
  const out: PauseReminderOutcome[] = [];
  try {
    const from = isoDay(new Date(today.getTime() + DAY_MS));
    const to = isoDay(new Date(today.getTime() + PAUSE_REMINDER_DAYS * DAY_MS));

    const { data, error } = await supabase
      .from("workspaces")
      .select("account_id, paused_until")
      .eq("status", "paused")
      .not("paused_until", "is", null)
      .gte("paused_until", from)
      .lte("paused_until", to);
    if (error) throw new Error(error.message);

    // One reminder per account, on the earliest date any of its sites carries -
    // which for an account pause is the same date on all of them.
    const earliest = new Map<string, string>();
    for (const row of data ?? []) {
      const accountId = row.account_id as string;
      const day = row.paused_until as string;
      if (!earliest.has(accountId) || day < earliest.get(accountId)!) earliest.set(accountId, day);
    }

    for (const [accountId, pausedUntil] of earliest) {
      const { data: account } = await supabase.from("accounts").select("name").eq("id", accountId).maybeSingle();
      const daysLeft = Math.max(
        1,
        Math.round((Date.parse(`${pausedUntil}T00:00:00Z`) - Date.parse(`${isoDay(today)}T00:00:00Z`)) / DAY_MS),
      );
      const sent = await notifyPauseEnding(supabase, accountId, {
        accountName: (account?.name as string | null) ?? null,
        pausedUntil,
        daysLeft,
      });
      out.push({ accountId, pausedUntil, emailed: describeSendOutcome(sent) });
    }
  } catch (err) {
    console.error(`[pause-reminder] ${err instanceof Error ? err.message : err}`);
  }
  return out;
}

/**
 * The cron's own skip reasons, translated into the one a customer can act on.
 *
 * Returns null for a skip that is not the customer's to fix - out of quota
 * (the billing emails cover that), the run's own article cap, the site not
 * being readable enough to judge keywords. Telling somebody "nothing was
 * written" for a reason they cannot change is a notification, not help.
 */
export function nothingWrittenReason(detail: string): NothingWrittenReason | null {
  if (detail === "weekly limit is 0") return "pace-zero";
  if (detail === "no keywords tracked for this workspace") return "no-keywords";
  if (detail.startsWith("no keyword qualifies")) return "queue-exhausted";
  return null;
}

/**
 * Tell a site's team that nothing is being written for it, and why.
 *
 * At most one a week per site (`sendOnce`, keyed by the ISO week), which is
 * what makes it safe to call from a cron that runs four times a day over the
 * same skipped workspaces.
 */
export async function announceNothingWritten(
  supabase: SupabaseClient,
  scope: { accountId: string; workspaceId: string; domain: string | null },
  reason: NothingWrittenReason,
  pausedUntil?: string | null,
  now: Date = new Date(),
): Promise<string> {
  try {
    // A site whose wizard was never finished gets the setup email instead
    // (sweepUnfinishedSetups), never this one. "Nothing is being written, add
    // keywords" to somebody who has not seen the plan screen yet sends them to
    // the wrong page for the wrong reason; what they left undone is setup.
    if (await setupUnfinished(supabase, scope.workspaceId)) return SETUP_UNFINISHED_LINE;
    const out = await notifyNothingWritten(
      supabase,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      { domain: scope.domain, reason, pausedUntil },
      now,
    );
    return describeSendOutcome(out);
  } catch (err) {
    return `email failed (${err instanceof Error ? err.message : "unknown"})`;
  }
}

/**
 * The sites the generate cron never even looks at: opted into automatic
 * drafting and paused.
 *
 * `cron/generate` filters `status = 'paused'` out of its query, which is
 * correct - a paused site must not be written for - but it means the one state
 * where "nothing is being written" is most obviously true is the one state the
 * loop cannot report on.
 */
export async function announcePausedSites(supabase: SupabaseClient, now: Date = new Date()): Promise<string[]> {
  const lines: string[] = [];
  try {
    const { data, error } = await supabase
      .from("workspaces")
      .select("id, domain, account_id, paused_until")
      .eq("auto_generate", true)
      .eq("status", "paused");
    if (error) throw new Error(error.message);

    for (const ws of data ?? []) {
      const line = await announceNothingWritten(
        supabase,
        {
          accountId: ws.account_id as string,
          workspaceId: ws.id as string,
          domain: (ws.domain as string | null) ?? null,
        },
        "paused",
        (ws.paused_until as string | null) ?? null,
        now,
      );
      if (line && line !== "nobody to email") lines.push(`${ws.domain ?? ws.id}: ${line}`);
    }
  } catch (err) {
    console.error(`[nothing-written] paused sweep: ${err instanceof Error ? err.message : err}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The account that stopped in the wizard
// ---------------------------------------------------------------------------
//
// Both dates null means the wizard was neither finished nor skipped
// (app/actions/onboarding-wizard.ts writes one or the other). The layout only
// bounces to /onboarding while there is no business_profile, and step 1 writes
// one, so from step 2 onwards nothing brings the person back - and the crons
// keep working on the site regardless: analyze reads it and finds keywords,
// generate writes a draft. The setup email is how they learn that.

/** What `announceNothingWritten` reports when it stood down for the setup email. */
export const SETUP_UNFINISHED_LINE = "setup never finished; the setup email covers it";

/** How long a stalled wizard is left alone before the no-draft email goes out. */
export const SETUP_FOLLOWUP_HOURS = 24;

async function setupUnfinished(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  const { data } = await supabase
    .from("workspaces")
    .select("onboarded_at, onboarding_skipped_at")
    .eq("id", workspaceId)
    .maybeSingle();
  return Boolean(data) && !data!.onboarded_at && !data!.onboarding_skipped_at;
}

/**
 * The facts the setup email may state, read from the database now.
 *
 * The draft is the oldest article in review, which for a site that never
 * finished setup is the one the generate cron wrote. The keyword count is a
 * count. "Unreadable" is set only from what the analysis recorded: an audit
 * that read zero pages, or no usable vocabulary and no keywords at all.
 */
export async function setupUnfinishedFacts(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string | null,
): Promise<SetupUnfinishedEmail> {
  const [{ data: article }, { count }, { data: ws }, { data: audit }] = await Promise.all([
    supabase
      .from("articles")
      .select("id, title, keyword")
      .eq("workspace_id", workspaceId)
      .eq("status", "review")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase.from("keywords").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
    supabase.from("workspaces").select("topical_profile").eq("id", workspaceId).maybeSingle(),
    supabase
      .from("domain_audits")
      .select("pages_crawled")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const keywordCount = count ?? 0;
  const readable = profileIsUsable((ws?.topical_profile as TopicalProfile | null) ?? null, domain ?? undefined);
  let unreadable: string | null = null;
  if (audit && audit.pages_crawled === 0) unreadable = "not one page answered";
  else if (!readable && keywordCount === 0) unreadable = "too little of its text could be read to find keywords";

  return {
    domain,
    draft: article
      ? { articleId: article.id as string, title: article.title as string, keyword: (article.keyword as string | null) ?? null }
      : null,
    keywordCount,
    unreadable,
  };
}

/**
 * Send the setup email for one site, with whatever is true of it right now.
 * Once per site ever; `sendOnce` holds that.
 */
export async function announceSetupUnfinished(
  supabase: SupabaseClient,
  scope: { accountId: string; workspaceId: string; domain: string | null },
): Promise<string> {
  try {
    const facts = await setupUnfinishedFacts(supabase, scope.workspaceId, scope.domain);
    const out = await notifySetupUnfinished(supabase, { accountId: scope.accountId, workspaceId: scope.workspaceId }, facts);
    return describeSendOutcome(out);
  } catch (err) {
    return `email failed (${err instanceof Error ? err.message : "unknown"})`;
  }
}

/**
 * Every site whose wizard stalled more than a day ago and that has been read.
 *
 * A day, so a person who is still in the wizard - or who comes back that
 * evening - is not chased. Read (`first_analysed_at` set), so the email can say
 * what was measured; a site the analyze cron has not reached yet is left for
 * the next run rather than told "we read your site" when nobody has. A site
 * whose draft was written earlier was told then (cron/generate); the ledger
 * makes this a no-op for it.
 */
export async function sweepUnfinishedSetups(supabase: SupabaseClient, now: Date = new Date()): Promise<string[]> {
  const lines: string[] = [];
  try {
    const before = new Date(now.getTime() - SETUP_FOLLOWUP_HOURS * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("workspaces")
      .select("id, domain, account_id")
      .is("onboarded_at", null)
      .is("onboarding_skipped_at", null)
      .not("first_analysed_at", "is", null)
      .not("domain", "is", null)
      .neq("status", "paused")
      .lt("created_at", before);
    if (error) throw new Error(error.message);

    // The ledger first, in one read: a stalled site stays stalled for as long
    // as it exists, and this runs four times a day. `sendOnce` would refuse
    // the duplicate anyway; this saves reading the facts to build it.
    const ids = (data ?? []).map((ws) => ws.id as string);
    const { data: told } = ids.length
      ? await supabase.from("sent_emails").select("workspace_id").eq("email_type", "setup_unfinished").in("workspace_id", ids)
      : { data: [] };
    const done = new Set((told ?? []).map((r) => r.workspace_id as string));

    for (const ws of data ?? []) {
      if (done.has(ws.id as string)) continue;
      const line = await announceSetupUnfinished(supabase, {
        accountId: ws.account_id as string,
        workspaceId: ws.id as string,
        domain: (ws.domain as string | null) ?? null,
      });
      if (line && line !== "nobody to email") lines.push(`${ws.domain ?? ws.id}: ${line}`);
    }
  } catch (err) {
    console.error(`[setup-unfinished] sweep: ${err instanceof Error ? err.message : err}`);
  }
  return lines;
}
