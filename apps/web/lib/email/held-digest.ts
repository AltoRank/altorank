// ---------------------------------------------------------------------------
// The daily note about drafts the automatic rule would not approve
// ---------------------------------------------------------------------------
//
// A workspace that publishes automatically has, by choice, nobody reading the
// review queue. So when the rule holds a draft for a reason a person can act
// on - an unsourced figure, a failing audit item, a score under the floor, no
// plan - saying so only on the article's own row is saying it to nobody. This
// is the one email that closes that gap: one per workspace per day, listing
// the held drafts and why, with a link to each.
//
// Hold-window skips and "held by a person" are not in it. The first is the
// rule working; the second is a decision already taken by the reader.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutoApproveResult } from "@/lib/publishing/auto-approve";
import { accountRecipients } from "./account-recipients";
import { describeSendOutcome, sendOnce } from "./send-once";
import { emailButton, emailParagraph, EMAIL_INK, EMAIL_INK_3 } from "./layout";
import { articleUrl } from "./article-emails";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A skip a person can do something about, as opposed to the rule waiting or obeying a hold. */
export function isActionableHold(detail: string | undefined): boolean {
  if (!detail) return false;
  return !(
    detail.startsWith("hold window ends") ||
    detail === "held by a person" ||
    detail.startsWith("auto-approve is off") ||
    detail.startsWith("status is") ||
    detail.startsWith("changed under us")
  );
}

export type HeldDraft = { articleId: string; title: string; reason: string };

export function renderHeldDigest(domain: string | null, held: readonly HeldDraft[]) {
  const site = domain ?? "your site";
  const n = held.length;
  const items = held
    .map(
      (h) =>
        `<li style="margin:0 0 10px;"><a href="${articleUrl(h.articleId)}" style="color:${EMAIL_INK};font-weight:600;text-decoration:none;">${esc(h.title)}</a>` +
        `<div style="font-size:13px;color:${EMAIL_INK_3};">${esc(h.reason)}</div></li>`,
    )
    .join("");
  return {
    subject: `${n} draft${n === 1 ? "" : "s"} for ${site} ${n === 1 ? "was" : "were"} not published automatically`,
    preheader: `Held for a reason you can fix. Nothing is lost; each waits in review.`,
    footerNote: `Sent because ${esc(site)} publishes automatically and the rule held something. Turn automatic publishing off in that workspace's settings and these stop.`,
    html:
      `<p style="margin:0 0 4px;font-size:12px;color:${EMAIL_INK_3};">${esc(site)}</p>` +
      `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${EMAIL_INK};">Not published automatically</h1>` +
      emailParagraph(
        `The publishing rule checked ${n === 1 ? "a draft" : `${n} drafts`} today and would not approve ${n === 1 ? "it" : "them"}. ${n === 1 ? "It waits" : "They wait"} in review with the reason; fix the reason or approve by hand and ${n === 1 ? "it ships" : "they ship"} on the next run.`,
      ) +
      `<ul style="margin:0 0 16px;padding-left:18px;font-size:14px;line-height:1.5;">${items}</ul>` +
      emailButton(articleUrl(held[0]!.articleId).replace(/\/content\/.*$/, "/articles?status=review"), "Open the review queue"),
  };
}

/** A window opener this old is the last time the team was told; the next digest reminds. */
export const HOLD_REMINDER_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** Nothing sent for this long means the hold ended and a fresh one may open a new window. */
export const HOLD_WINDOW_RESET_MS = 14 * 24 * 60 * 60 * 1000;

const REMINDER_SUFFIX = ":reminder";

export type HoldDigestSlot =
  | { kind: "opener" | "reminder"; subjectId: string }
  | { kind: "skip"; reason: string };

/**
 * Which digest, if any, this hold window still owes the workspace.
 *
 * Keyed on the window, not the day. The ledger held one row per (workspace,
 * UTC date), so a workspace whose drafts sat in review got the same list every
 * morning: a real account collected eight of these in eight days and never
 * signed in again. A window opens with the first digest, may send one
 * reminder once the opener is HOLD_REMINDER_AFTER_MS old, and then says
 * nothing until the ledger has been quiet for HOLD_WINDOW_RESET_MS. The
 * opener's key carries the day it opened; the reminder's key is the opener's
 * plus a suffix, so a run that repeats is still caught by the ledger.
 */
export async function holdDigestSlot(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<HoldDigestSlot> {
  const { data, error } = await supabase
    .from("sent_emails")
    .select("subject_id, sent_at")
    .eq("email_type", "auto_approve_held")
    .eq("workspace_id", workspaceId)
    .order("sent_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`could not read the hold ledger: ${error.message}`);
  const last = data?.[0] as { subject_id: string; sent_at: string } | undefined;
  const day = now.toISOString().slice(0, 10);
  if (!last) return { kind: "opener", subjectId: `${workspaceId}:hold:${day}` };

  const age = now.getTime() - new Date(last.sent_at).getTime();
  if (age >= HOLD_WINDOW_RESET_MS) return { kind: "opener", subjectId: `${workspaceId}:hold:${day}` };
  if (last.subject_id.endsWith(REMINDER_SUFFIX)) {
    return { kind: "skip", reason: "reminded already this hold window" };
  }
  if (age >= HOLD_REMINDER_AFTER_MS) {
    return { kind: "reminder", subjectId: `${last.subject_id}${REMINDER_SUFFIX}` };
  }
  return { kind: "skip", reason: `told ${Math.floor(age / 86_400_000)} day(s) ago, reminder waits` };
}

/**
 * From one cron pass: group the actionable holds by workspace and send each
 * workspace's team one digest per hold window, plus one reminder after three
 * days (`holdDigestSlot`). Never throws; returns one line per workspace for
 * the run's JSON.
 */
export async function sendHeldDigests(
  supabase: SupabaseClient,
  results: readonly AutoApproveResult[],
  now: Date = new Date(),
): Promise<string[]> {
  const byWorkspace = new Map<string, AutoApproveResult[]>();
  for (const r of results) {
    if (r.outcome !== "held" || !r.articleId || !isActionableHold(r.detail)) continue;
    const list = byWorkspace.get(r.workspaceId) ?? [];
    list.push(r);
    byWorkspace.set(r.workspaceId, list);
  }
  if (!byWorkspace.size) return [];

  const lines: string[] = [];
  for (const [workspaceId, held] of byWorkspace) {
    try {
      const slot = await holdDigestSlot(supabase, workspaceId, now);
      if (slot.kind === "skip") {
        lines.push(`${workspaceId}: ${held.length} held, ${slot.reason}`);
        continue;
      }
      const [{ data: ws }, { data: articles }] = await Promise.all([
        supabase.from("workspaces").select("account_id, domain").eq("id", workspaceId).maybeSingle(),
        supabase.from("articles").select("id, title").in("id", held.map((h) => h.articleId)),
      ]);
      if (!ws) continue;
      const titles = new Map((articles ?? []).map((a) => [a.id as string, (a.title as string) || "Untitled draft"]));
      const drafts: HeldDraft[] = held.map((h) => ({ articleId: h.articleId, title: titles.get(h.articleId) ?? "Untitled draft", reason: h.detail ?? "" }));
      const to = await accountRecipients(supabase, ws.account_id as string, workspaceId);
      const out = await sendOnce(
        supabase,
        to,
        { type: "auto_approve_held", subjectId: slot.subjectId, category: "drafts", accountId: ws.account_id as string, workspaceId },
        () => renderHeldDigest((ws.domain as string | null) ?? null, drafts),
      );
      lines.push(`${workspaceId}: ${drafts.length} held, ${slot.kind}, ${describeSendOutcome(out)}`);
    } catch (err) {
      lines.push(`${workspaceId}: digest failed (${err instanceof Error ? err.message : "unknown"})`);
    }
  }
  return lines;
}
