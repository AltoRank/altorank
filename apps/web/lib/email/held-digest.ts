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

/**
 * From one cron pass: group the actionable holds by workspace and send each
 * workspace's team one digest for the day. Keyed by (workspace, UTC date) in
 * `sent_emails`, so a cron that runs more than once a day still sends once.
 * Never throws; returns one line per workspace for the run's JSON.
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
  const day = now.toISOString().slice(0, 10);
  for (const [workspaceId, held] of byWorkspace) {
    try {
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
        { type: "auto_approve_held", subjectId: `${workspaceId}:${day}`, category: "drafts", accountId: ws.account_id as string, workspaceId },
        () => renderHeldDigest((ws.domain as string | null) ?? null, drafts),
      );
      lines.push(`${workspaceId}: ${drafts.length} held, ${describeSendOutcome(out)}`);
    } catch (err) {
      lines.push(`${workspaceId}: digest failed (${err instanceof Error ? err.message : "unknown"})`);
    }
  }
  return lines;
}
