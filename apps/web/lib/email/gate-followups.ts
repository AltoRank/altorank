// ---------------------------------------------------------------------------
// After the gate: two emails to someone who read the offer and left
// ---------------------------------------------------------------------------
//
// Until 2026-11-15 a person who reached the trial offer got one email, "your
// article is ready", and then nothing, ever. Whoever read the offer and left
// never heard from us again, and a person who came back on their own found
// the same screen.
//
//   a day later     the next articles the trial would write, by name, with
//                   how often each is searched. Sent only when there is one
//                   to name.
//   four days later the one question: what stopped you? Each answer is a
//                   link to /why (lib/email/why-link.ts). Not sent to a site
//                   that has answered, on the gate or from the first email.
//
// Each once per site, ever (`sendOnce`), only while the account is still
// before its trial, and only inside a window that starts at the site's FIRST
// gate visit: a site that reached the gate before this shipped is past both
// windows and is not written to. Both are "Workspace status" mail, so the
// unsubscribe link in the footer stops them.
//
// Run from the generate cron, beside the other things the schedule has to
// say out loud (./schedule-events.ts). Neither can fail the run.

import type { SupabaseClient } from "@supabase/supabase-js";
import { accountRecipients } from "./account-recipients";
import { emailHeader, esc, trialGateUrl } from "./article-emails";
import { emailButton, emailParagraph, EMAIL_INK_2, EMAIL_INK_3 } from "./layout";
import { describeSendOutcome, sendOnce, type RenderedEmail } from "./send-once";
import { whyUrl } from "./why-link";
import { accountTrialGate } from "@/lib/billing/body-lock";
import { priceLabel } from "@/lib/billing/trial-offer";
import { TRIAL_DAYS } from "@/lib/stripe";
import { GATE_REASON_LABELS } from "@/lib/onboarding/gate-answer";
import { gateAnswered } from "@/lib/onboarding/gate-answer-store";
import { nextArticles } from "@/lib/onboarding/next-articles";
import { latestRun } from "@/lib/onboarding/run-store";
import { GATE_REASONS } from "@/lib/onboarding/step-props";

export const GATE_FOLLOWUP_TOPICS = "gate_followup_topics";
export const GATE_FOLLOWUP_WHY = "gate_followup_why";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The next-articles email: from a day after the first gate visit, for two days. */
export const TOPICS_AFTER_MS = DAY_MS;
export const TOPICS_WITHIN_MS = 3 * DAY_MS;
/** The question: from four days after, for six. A cron that misses a morning does not miss the email. */
export const WHY_AFTER_MS = 4 * DAY_MS;
export const WHY_WITHIN_MS = 10 * DAY_MS;

export type FollowupKind = "topics" | "why";

/**
 * Which email a site is due, if any, from how long ago its gate was first
 * shown. Pure. The next-articles email needs an article to name; the
 * question is not asked of a site that has answered it.
 */
export function followupDue(
  firstSeenMs: number,
  now: number,
  state: { topicsSent: boolean; whySent: boolean; answered: boolean; topics: number },
): FollowupKind | null {
  const age = now - firstSeenMs;
  if (!state.topicsSent && state.topics > 0 && age >= TOPICS_AFTER_MS && age <= TOPICS_WITHIN_MS) return "topics";
  if (!state.whySent && !state.answered && age >= WHY_AFTER_MS && age <= WHY_WITHIN_MS) return "why";
  return null;
}

export interface NextTopic {
  term: string;
  /** Monthly searches in the site's market, when the keyword row has them. */
  volume: number | null;
}

export interface GateFollowupFacts {
  workspaceId: string;
  domain: string | null;
  /** The first article's title. */
  title: string;
  /** The owner put the first article on their own site (lib/found-on-site). */
  live: boolean;
  topics: NextTopic[];
}

const link = (href: string, text: string) => `<a href="${esc(href)}" style="color:${EMAIL_INK_2};">${esc(text)}</a>`;

/** "searched about 4,400 times a month", or nothing when the count is unknown or zero. */
function searched(volume: number | null): string {
  return volume && volume > 0 ? `, searched about ${volume.toLocaleString("en")} times a month` : "";
}

/** A day after the gate: what the trial would write next, by name. */
export function renderGateFollowupTopics(a: GateFollowupFacts, recipient: string): RenderedEmail {
  const site = a.domain ?? "your site";
  const why = whyUrl(a.workspaceId, recipient);
  return {
    subject: `Your next articles for ${site}`,
    preheader: a.topics.length > 1 ? `${a.topics[0].term} and ${a.topics.length - 1} more are ready to write.` : `${a.topics[0]?.term ?? "The next one"} is ready to write.`,
    footerNote: `Sent because you set up ${site} on AltoRank and have not started the trial. At most one more email follows.`,
    html:
      emailHeader(site, "Your next articles") +
      emailParagraph(
        `The first article we wrote for <strong>${esc(site)}</strong>, “${esc(a.title)}”, is still in your account.` +
          (a.live ? ` You put it on your site, so it can already be found.` : ""),
      ) +
      emailParagraph(`One article gets found for one search. A site gets found by adding one every week. These are ready to write next:`) +
      a.topics.map((t) => emailParagraph(`<strong>${esc(t.term)}</strong>${esc(searched(t.volume))}`)).join("") +
      emailParagraph(`The ${TRIAL_DAYS}-day trial writes them. A card is required, €0 is charged today, then ${esc(priceLabel("month"))} unless you cancel first.`) +
      emailButton(trialGateUrl(), "See your next articles") +
      (why ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:${EMAIL_INK_3};">Not for you? ${link(why, "Tell us what stopped you")}. It takes one click.</p>` : ""),
  };
}

/** Four days after the gate: the one question, each answer a link. */
export function renderGateFollowupWhy(a: Pick<GateFollowupFacts, "workspaceId" | "domain">, recipient: string): RenderedEmail {
  const site = a.domain ?? "your site";
  const answers = GATE_REASONS.map((reason) => {
    const href = whyUrl(a.workspaceId, recipient, reason);
    return href ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;">${link(href, GATE_REASON_LABELS[reason])}</p>` : "";
  }).join("");
  return {
    subject: `What stopped you?`,
    preheader: `One click tells us. Your article for ${site} stays in your account.`,
    footerNote: `Sent because you set up ${site} on AltoRank and have not started the trial. This is the last email about it.`,
    html:
      emailHeader(site, "What stopped you?") +
      emailParagraph(
        `You read the article we wrote for <strong>${esc(site)}</strong> and did not start the trial. That is fine. We would like to know why, so we fix the right thing.`,
      ) +
      emailParagraph(`Pick the closest one:`) +
      answers +
      `<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:${EMAIL_INK_3};">Your article stays in your account either way: ${link(trialGateUrl(), "open it")}.</p>`,
  };
}

/** What the next-articles email says about one site, or null when it has no first article to speak of. */
export async function gateFollowupFacts(supabase: SupabaseClient, workspaceId: string, domain: string | null): Promise<GateFollowupFacts | null> {
  const { run, article, held } = await latestRun(supabase, workspaceId);
  if (!run || !article?.title || article.status === "error" || !(article.word_count && article.word_count > 0)) return null;
  const names = nextArticles(run.planned ?? [], held?.topics, article.keyword);
  let volumes = new Map<string, number | null>();
  if (names.length) {
    const { data } = await supabase.from("keywords").select("term, volume").eq("workspace_id", workspaceId).in("term", names);
    volumes = new Map((data ?? []).map((k) => [(k.term as string).trim().toLowerCase(), (k.volume as number | null) ?? null]));
  }
  return {
    workspaceId,
    domain,
    title: article.title,
    live: article.status === "live",
    topics: names.map((term) => ({ term, volume: volumes.get(term.trim().toLowerCase()) ?? null })),
  };
}

/**
 * Send whichever follow-up each site is due. Returns one line per site
 * written to, for the cron's answer. Never throws: a site that cannot be
 * read is left for the next sweep, which asks again inside the same window.
 */
export async function sweepGateFollowups(supabase: SupabaseClient, now: Date = new Date()): Promise<string[]> {
  const lines: string[] = [];
  try {
    // Sites whose gate was shown inside the longest window, then every visit
    // of theirs: the windows count from the first, and a return last week to
    // a gate first shown in September is not a new arrival.
    const { data: recent, error } = await supabase.from("gate_visits").select("workspace_id").gte("seen_at", new Date(now.getTime() - WHY_WITHIN_MS).toISOString());
    if (error) throw new Error(error.message);
    const ids = [...new Set((recent ?? []).map((r) => r.workspace_id as string))];
    if (ids.length === 0) return lines;
    const { data: visits, error: visitsError } = await supabase.from("gate_visits").select("workspace_id, account_id, seen_at").in("workspace_id", ids);
    if (visitsError) throw new Error(visitsError.message);
    const first = new Map<string, { accountId: string; at: number }>();
    for (const v of visits ?? []) {
      const at = Date.parse(v.seen_at as string);
      const held = first.get(v.workspace_id as string);
      if (Number.isFinite(at) && (!held || at < held.at)) first.set(v.workspace_id as string, { accountId: v.account_id as string, at });
    }

    const [{ data: sent }, answered] = await Promise.all([
      supabase.from("sent_emails").select("workspace_id, email_type").in("email_type", [GATE_FOLLOWUP_TOPICS, GATE_FOLLOWUP_WHY]).in("workspace_id", ids),
      gateAnswered(supabase, ids),
    ]);
    const told = new Set((sent ?? []).map((r) => `${r.workspace_id}:${r.email_type}`));

    for (const [workspaceId, seen] of first) {
      const state = {
        topicsSent: told.has(`${workspaceId}:${GATE_FOLLOWUP_TOPICS}`),
        whySent: told.has(`${workspaceId}:${GATE_FOLLOWUP_WHY}`),
        answered: answered.has(workspaceId),
      };
      // Before reading anything about the site: is either email in its window at all?
      if (!followupDue(seen.at, now.getTime(), { ...state, topics: 1 })) continue;
      try {
        // Still before the trial. A trial that started, a plan, or an install
        // with billing off has nothing to be followed up about.
        if ((await accountTrialGate(supabase, seen.accountId, null)) !== "gated") continue;
        const { data: ws } = await supabase.from("workspaces").select("domain, status").eq("id", workspaceId).maybeSingle();
        if (!ws || ws.status === "paused") continue;
        const facts = await gateFollowupFacts(supabase, workspaceId, (ws.domain as string | null) ?? null);
        // No article was written: there is nothing to follow up on, and
        // "what stopped you" has an answer we already know.
        if (!facts) continue;
        const due = followupDue(seen.at, now.getTime(), { ...state, topics: facts.topics.length });
        if (!due) continue;
        const to = await accountRecipients(supabase, seen.accountId, workspaceId);
        const out = await sendOnce(
          supabase,
          to,
          { type: due === "topics" ? GATE_FOLLOWUP_TOPICS : GATE_FOLLOWUP_WHY, subjectId: workspaceId, category: "product", accountId: seen.accountId, workspaceId },
          (recipient) => (due === "topics" ? renderGateFollowupTopics(facts, recipient) : renderGateFollowupWhy(facts, recipient)),
        );
        const line = describeSendOutcome(out);
        if (line !== "nobody to email") lines.push(`${facts.domain ?? workspaceId}: ${due}, ${line}`);
      } catch (err) {
        console.error(`[gate-followups] ${workspaceId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    console.error(`[gate-followups] sweep: ${err instanceof Error ? err.message : err}`);
  }
  return lines;
}
