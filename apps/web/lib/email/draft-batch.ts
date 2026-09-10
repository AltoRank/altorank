// ---------------------------------------------------------------------------
// One email for the drafts that arrived together
// ---------------------------------------------------------------------------
//
// A signup does not produce one draft, it produces a week of them. The
// onboarding run writes the first and fans the other six out into their own
// invocations (lib/content/fan-out.ts), so seven land within a few minutes of
// each other. Until now that path sent nothing at all: `sendArticleDraftedEmails`
// had exactly one caller, `cron/generate`, and the signup fan-out was not it.
//
// The cost of that was measured rather than guessed. On a real signup the
// pipeline delivered everything it promised - keywords, a calendar, seven
// drafts in review within the hour - and the account's mailbox held exactly one
// message from us: `welcome`. They connected analytics minutes later and came
// back the next morning, so they were looking for what to do next; there was
// nothing to find, because the only place the seven drafts were announced was a
// page nobody had been given a reason to open. The product's entire first week
// of output sat unseen. (The account is named in the round-7 notes, not here.)
//
// Seven separate "a draft is ready" mails would have been the other failure.
// So: one digest per batch, listing them, and the single-draft mail
// (lib/email/article-emails.ts) stays for the daily cron, which genuinely is
// one draft at a time. Same shape as lib/email/held-digest.ts - the other
// per-workspace `drafts` digest - and through the same `sendOnce`, so the
// unsubscribe, the RFC 8058 headers and the send-once ledger are the ones
// every other lifecycle email already uses.
//
// The ledger does double duty here. The digest claims its own key so a retry
// cannot repeat it, and then claims `article_drafted` for every article it
// listed. That second write is what makes the two shapes exclusive: an article
// announced in a digest can never be announced again on its own by the cron,
// and an article the cron already announced is never swept into a digest.

import type { SupabaseClient } from "@supabase/supabase-js";
import { accountRecipients } from "./account-recipients";
import { describeSendOutcome, normalizeRecipients, sendOnce } from "./send-once";
import {
  ARTICLE_DRAFTED,
  approvalLine,
  articleUrl,
  cmsLine,
  emailHeader,
  esc,
  figure,
  reviewQueueUrl,
  sendArticleDraftedEmails,
  VERDICT_PILL,
} from "./article-emails";
import {
  emailButton,
  emailCard,
  emailNote,
  emailParagraph,
  emailPill,
  emailCode,
  emailStatRow,
  EMAIL_INK,
  EMAIL_INK_3,
  EMAIL_LINE_SOFT,
  EMAIL_MONO,
  type EmailStat,
} from "./layout";
import { getDestinations } from "@/lib/publishing/destinations";
import type { FactCheckReport } from "@/lib/ai/fact-check";

/** The digest's own slug in `sent_emails`. */
export const DRAFT_BATCH = "article_batch_drafted";

/** Rows past this are counted, not listed: a mail is not a table view. */
export const MAX_LISTED = 12;

/**
 * How long after it was written a draft may still be swept into a digest.
 *
 * A week. Long enough that a fan-out whose announcement never left (the
 * function that fired it was frozen before `after()` finished) is still caught
 * by the cron's sweep the next morning; short enough that turning the emails
 * back on after a long unsubscribe does not open with a month of history.
 */
export const BATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How settled a draft must be before a sweep will digest it.
 *
 * The fan-out's own announcement runs the moment the last request answers, and
 * a cron that reached the same workspace mid-fan-out would send a digest of
 * three drafts and leave four for a second one. Twenty minutes is comfortably
 * past the slowest observed draft (280s) without making the safety net slow.
 */
export const SETTLE_MS = 20 * 60 * 1000;

export interface BatchDraft {
  articleId: string;
  title: string;
  keyword: string;
  wordCount: number;
  verdict: FactCheckReport["verdict"];
  /** See ArticleDraftedEmail: undefined is "nobody looked", null is "nothing measured". */
  volume?: number | null;
}

export interface DraftBatchEmail {
  domain: string | null;
  drafts: readonly BatchDraft[];
  /** More drafts than `MAX_LISTED`, so the list is cut and the count says so. */
  total: number;
  autoApproveAfter?: string | null;
  cmsConnected?: boolean;
}

/**
 * What the fact check found, and how alarmed the cell should look.
 *
 * Phrased as a result, not an instruction: the check is automatic, run on
 * every draft in `lib/content/generate.ts` before anyone sees it, and its
 * verdict already gates approval (`approvalBlocker`). "1 to check" read like a
 * job the reader had been given; "1 unsourced figure" is what we actually
 * found.
 */
function factCheckStat(drafts: readonly BatchDraft[]): EmailStat {
  const risky = drafts.filter((d) => d.verdict === "high_risk").length;
  const review = drafts.filter((d) => d.verdict === "review").length;
  if (risky) return { label: "Fact check", value: `${risky} unsourced ${risky === 1 ? "figure" : "figures"}`, tone: "err" };
  if (review) return { label: "Fact check", value: `${review} to confirm`, tone: "warn" };
  return { label: "Fact check", value: "All sourced", tone: "ok" };
}

/**
 * The searches these keywords add up to, when anybody measured them.
 *
 * `undefined` when not one draft carries a number, which leaves the cell out
 * rather than printing a zero that would read as "nothing searches for any of
 * this" - the same rule the keywords table follows (components/dashboard/
 * client-tabs.tsx renders "—", never 0).
 */
function totalVolume(drafts: readonly BatchDraft[]): number | undefined {
  const known = drafts.map((d) => d.volume).filter((v): v is number => typeof v === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
}

export function renderDraftBatch(b: DraftBatchEmail): {
  subject: string;
  html: string;
  preheader: string;
  footerNote: string;
} {
  const site = b.domain ?? "your site";
  const n = b.total;
  const words = b.drafts.reduce((a, d) => a + d.wordCount, 0);
  const risky = b.drafts.filter((d) => d.verdict === "high_risk").length;
  const volume = totalVolume(b.drafts);

  const stats: EmailStat[] = [
    { label: "Drafts", value: n.toLocaleString() },
    { label: "Words", value: words.toLocaleString() },
    factCheckStat(b.drafts),
  ];
  if (volume !== undefined) stats.push({ label: "Searches", value: figure(volume), unit: "/mo" });

  const rows = b.drafts
    .slice(0, MAX_LISTED)
    .map((d, i) => {
      const v = VERDICT_PILL[d.verdict];
      return (
        `<tr><td style="padding:12px 16px;${i === 0 ? "" : `border-top:1px solid ${EMAIL_LINE_SOFT};`}">` +
        `<a href="${articleUrl(d.articleId)}" style="color:${EMAIL_INK};font-size:14px;font-weight:600;line-height:1.4;text-decoration:none;">${esc(d.title)}</a>` +
        `<div style="margin-top:5px;font-size:12px;line-height:1.6;color:${EMAIL_INK_3};">` +
        `<span style="font-family:${EMAIL_MONO};">${esc(d.wordCount.toLocaleString())}</span> words` +
        ` &middot; ${emailCode(d.keyword)}` +
        (d.verdict === "clean" ? "" : ` &middot; ${emailPill(v.label, v.tone)}`) +
        `</div></td></tr>`
      );
    })
    .join("");

  const more =
    n > b.drafts.length || b.drafts.length > MAX_LISTED
      ? `<tr><td style="padding:11px 16px;border-top:1px solid ${EMAIL_LINE_SOFT};font-size:12.5px;color:${EMAIL_INK_3};">` +
        `and ${n - Math.min(b.drafts.length, MAX_LISTED)} more in the queue</td></tr>`
      : "";

  return {
    subject: risky
      ? `${n} drafts for ${site}, ${risky === 1 ? "one" : risky} with a figure to confirm`
      : `${n} drafts are ready for ${site}`,
    preheader: b.autoApproveAfter
      ? `${words.toLocaleString()} words across ${n} keywords, publishing on their own unless you hold them.`
      : `${words.toLocaleString()} words across ${n} keywords, waiting for your approval.`,
    footerNote: `Sent because AltoRank wrote these drafts for ${esc(site)}.`,
    html:
      emailHeader(site, `${n} draft${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} ready to read`) +
      emailStatRow(stats) +
      emailParagraph(approvalLine(b.autoApproveAfter, n)) +
      emailCard({
        title: "In review",
        flush: true,
        bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}${more}</table>`,
      }) +
      emailButton(reviewQueueUrl(), `Review ${n === 1 ? "the draft" : `all ${n}`}`) +
      cmsLine(b.cmsConnected, site) +
      emailNote(
        `Each draft says why its keyword was chosen. Changing what the site tracks changes what gets written next.`,
      ),
  };
}

/** One line for a caller's log, in the shape the crons already return. */
export type AnnounceLine = string;

export interface AnnounceOptions {
  now?: Date;
  /** Only articles written after this are candidates. Defaults to the batch window. */
  since?: Date;
  /** Ignore drafts younger than SETTLE_MS. The sweep sets this; the fan-out does not. */
  settledOnly?: boolean;
}

type WorkspaceRow = {
  id: string;
  account_id: string;
  domain: string | null;
  auto_approve: boolean | null;
  auto_approve_hold_hours: number | null;
};

type ArticleRow = {
  id: string;
  title: string | null;
  keyword: string | null;
  keyword_id: string | null;
  word_count: number | null;
  fact_check_verdict: string | null;
  created_at: string | null;
  auto_approve_after: string | null;
};

const VERDICTS = new Set(["clean", "review", "high_risk"]);
const verdictOf = (v: string | null): FactCheckReport["verdict"] =>
  VERDICTS.has(v ?? "") ? (v as FactCheckReport["verdict"]) : "clean";

/**
 * Tell this workspace's team about every draft of theirs nobody has been told
 * about yet.
 *
 * One digest when there are several, the ordinary single-draft mail when there
 * is one, and nothing at all when there are none - which is the common case,
 * because the cron announces its own drafts as it writes them.
 *
 * Never throws. Every caller is announcing work that is already saved, and a
 * mail provider being unreachable must not turn seven written drafts into a
 * failed onboarding run.
 */
export async function announceDraftBatch(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: AnnounceOptions = {},
): Promise<AnnounceLine> {
  const now = opts.now ?? new Date();
  try {
    const { data: wsRow } = await supabase
      .from("workspaces")
      .select("id, account_id, domain, auto_approve, auto_approve_hold_hours")
      .eq("id", workspaceId)
      .maybeSingle();
    const ws = wsRow as WorkspaceRow | null;
    if (!ws) return "workspace not found";

    const since = (opts.since ?? new Date(now.getTime() - BATCH_WINDOW_MS)).toISOString();
    const { data: rows, error } = await supabase
      .from("articles")
      .select("id, title, keyword, keyword_id, word_count, fact_check_verdict, created_at, auto_approve_after")
      .eq("workspace_id", workspaceId)
      .eq("status", "review")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw new Error(error.message);

    let candidates = (rows ?? []) as ArticleRow[];
    if (opts.settledOnly) {
      const cutoff = now.getTime() - SETTLE_MS;
      candidates = candidates.filter((a) => !a.created_at || new Date(a.created_at).getTime() <= cutoff);
    }
    if (!candidates.length) return "no drafts to announce";

    // The ledger decides what is new, in one read. Both slugs, because a draft
    // the cron already mailed on its own must not come back in a digest.
    const ids = candidates.map((a) => a.id);
    const { data: told } = await supabase
      .from("sent_emails")
      .select("subject_id")
      .in("email_type", [ARTICLE_DRAFTED, DRAFT_BATCH])
      .in("subject_id", ids);
    const announced = new Set((told ?? []).map((r) => r.subject_id as string));
    const fresh = candidates.filter((a) => !announced.has(a.id));
    if (!fresh.length) return "no drafts to announce";

    const to = await accountRecipients(supabase, ws.account_id, workspaceId);
    if (!normalizeRecipients(to).length) return "nobody to email";

    // The keyword's own figures, for the stat row. One read for the batch; a
    // draft whose keyword row is gone simply carries no volume.
    const keywordIds = [...new Set(fresh.map((a) => a.keyword_id).filter((k): k is string => Boolean(k)))];
    const { data: keywordRows } = keywordIds.length
      ? await supabase.from("keywords").select("id, volume, difficulty").in("id", keywordIds)
      : { data: [] };
    const byKeyword = new Map(
      (keywordRows ?? []).map((k) => [
        k.id as string,
        {
          volume: typeof k.volume === "number" ? (k.volume as number) : null,
          difficulty: typeof k.difficulty === "number" ? (k.difficulty as number) : null,
        },
      ]),
    );

    // A workspace that publishes automatically gets its hold window stamped
    // here, because here is where the window starts meaning something: it is
    // the time between being told and it going live. The fan-out never stamped
    // one, so `runAutoApprovals` was counting the hold from `created_at` - the
    // moment the draft was written, which on a signup is minutes before this
    // mail and, without this mail, was never announced at all.
    const autoApproveAfter = await stampHoldWindow(supabase, ws, fresh, now);

    const cmsConnected = await hasDestination(supabase, workspaceId);

    const scope = { accountId: ws.account_id, workspaceId };
    const out =
      fresh.length === 1
        ? await sendArticleDraftedEmails(
            supabase,
            to,
            {
              domain: ws.domain,
              keyword: fresh[0]!.keyword ?? "",
              title: fresh[0]!.title ?? "Untitled draft",
              wordCount: fresh[0]!.word_count ?? 0,
              verdict: verdictOf(fresh[0]!.fact_check_verdict),
              reasons: [],
              articleId: fresh[0]!.id,
              volume: byKeyword.get(fresh[0]!.keyword_id ?? "")?.volume,
              difficulty: byKeyword.get(fresh[0]!.keyword_id ?? "")?.difficulty,
              cmsConnected,
              autoApproveAfter,
            },
            scope,
          )
        : await sendOnce(
            supabase,
            to,
            // Keyed on the oldest unannounced draft, so a retry after a partial
            // failure builds the same key and reaches only the addresses the
            // first attempt could not.
            { type: DRAFT_BATCH, subjectId: `${workspaceId}:${fresh[0]!.id}`, category: "drafts", ...scope },
            () =>
              renderDraftBatch({
                domain: ws.domain,
                total: fresh.length,
                autoApproveAfter,
                cmsConnected,
                drafts: fresh.map((a) => ({
                  articleId: a.id,
                  title: a.title ?? "Untitled draft",
                  keyword: a.keyword ?? "",
                  wordCount: a.word_count ?? 0,
                  verdict: verdictOf(a.fact_check_verdict),
                  volume: byKeyword.get(a.keyword_id ?? "")?.volume,
                })),
              }),
          );

    // Only once nothing failed. A send that could not leave keeps its articles
    // unclaimed, so the next pass tries them again; claiming them here would
    // turn one unreachable mail provider into seven drafts nobody is ever told
    // about, which is the exact failure this file exists to fix.
    if (out.failed === 0 && fresh.length > 1) await claimAnnounced(supabase, fresh, to, scope);

    return `${fresh.length} draft${fresh.length === 1 ? "" : "s"}, ${describeSendOutcome(out)}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`[draft-batch] ${workspaceId}: ${message}`);
    return `digest failed (${message})`;
  }
}

/**
 * Mark every article in a digest as announced, so neither the cron's
 * single-draft mail nor a later sweep repeats it.
 *
 * `ignoreDuplicates` rather than a plain insert: the digest's own `sendOnce`
 * has already claimed its key, and a second recipient added to the account
 * between two passes must not make the whole write fail on one existing row.
 * A failure here is logged and swallowed - at worst somebody hears about one
 * draft twice, which is better than the send being rolled back.
 */
async function claimAnnounced(
  supabase: SupabaseClient,
  articles: readonly { id: string }[],
  recipients: readonly string[],
  scope: { accountId: string; workspaceId: string },
): Promise<void> {
  const to = normalizeRecipients(recipients);
  if (!to.length) return;
  const rows = articles.flatMap((a) =>
    to.map((recipient) => ({
      email_type: ARTICLE_DRAFTED,
      subject_id: a.id,
      recipient,
      account_id: scope.accountId,
      workspace_id: scope.workspaceId,
    })),
  );
  const { error } = await supabase
    .from("sent_emails")
    .upsert(rows, { onConflict: "email_type,subject_id,recipient", ignoreDuplicates: true });
  if (error) console.error(`[draft-batch] could not record the digest's articles: ${error.message}`);
}

/**
 * Start the hold window on the drafts this mail is about, when the workspace
 * publishes automatically. Returns the stamp for the mail to quote, or null.
 *
 * Best effort: an unstamped draft still holds, counted from `created_at`
 * (lib/publishing/auto-approve.ts), so a failure here costs the reader a few
 * hours of window rather than the gate itself. A draft that already carries a
 * stamp keeps it - the cron stamps its own, and re-stamping would silently
 * extend a window somebody may already be watching.
 */
async function stampHoldWindow(
  supabase: SupabaseClient,
  ws: WorkspaceRow,
  articles: readonly ArticleRow[],
  now: Date,
): Promise<string | null> {
  if (!ws.auto_approve) return null;
  const existing = articles.find((a) => a.auto_approve_after)?.auto_approve_after ?? null;
  if (existing) return existing;
  const hours = Number(ws.auto_approve_hold_hours ?? 24);
  const stamp = new Date(now.getTime() + hours * 3_600_000).toISOString();
  const { error } = await supabase
    .from("articles")
    .update({ auto_approve_after: stamp })
    .in("id", articles.map((a) => a.id))
    .is("auto_approve_after", null);
  return error ? null : stamp;
}

/** Whether anything is connected to publish to. Never fatal; unknown reads as connected. */
async function hasDestination(supabase: SupabaseClient, workspaceId: string): Promise<boolean | undefined> {
  try {
    return (await getDestinations(supabase, workspaceId)).length > 0;
  } catch {
    return undefined;
  }
}

/**
 * The safety net: every workspace holding drafts nobody has been told about.
 *
 * The fan-out announces its own batch the moment the last draft lands, from
 * `after()` on the onboarding worker - and `after()` is exactly the kind of
 * work a serverless platform is free to cut short. This is the pass that
 * notices, run from `cron/generate` beside the other sweeps there. It is also
 * what covers a draft written by any path that forgets to announce one,
 * because "the customer was not told" is a state worth checking for rather
 * than a bug worth trusting nobody will reintroduce.
 *
 * Bounded: only drafts written in the last week, only ones settled for twenty
 * minutes, and one digest per workspace per pass. Never throws.
 */
export async function sweepUnannouncedDrafts(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<AnnounceLine[]> {
  const lines: AnnounceLine[] = [];
  try {
    const since = new Date(now.getTime() - BATCH_WINDOW_MS).toISOString();
    const before = new Date(now.getTime() - SETTLE_MS).toISOString();
    const { data, error } = await supabase
      .from("articles")
      .select("workspace_id")
      .eq("status", "review")
      .gte("created_at", since)
      .lte("created_at", before);
    if (error) throw new Error(error.message);

    for (const workspaceId of new Set((data ?? []).map((r) => r.workspace_id as string))) {
      const line = await announceDraftBatch(supabase, workspaceId, { now, settledOnly: true });
      if (line !== "no drafts to announce" && line !== "nobody to email") {
        lines.push(`${workspaceId}: ${line}`);
      }
    }
  } catch (err) {
    console.error(`[draft-batch] sweep: ${err instanceof Error ? err.message : err}`);
  }
  return lines;
}
