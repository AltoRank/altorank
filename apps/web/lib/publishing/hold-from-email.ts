// ---------------------------------------------------------------------------
// The hold a signed link asks for: who is holding, and whether it can apply
// ---------------------------------------------------------------------------
//
// /hold shows this on GET and writes it only on POST (app/hold/actions.ts).
// The split exists because mail security scanners (Defender Safe Links,
// Proofpoint, Mimecast, Barracuda) fetch every link in an inbound message
// before the recipient sees it: a hold written on GET held every auto-approve
// draft on a corporate tenant before anyone read the email, the same failure
// /unsubscribe was rebuilt for.
//
// Both steps call `resolveEmailHold`, so the POST checks everything again
// rather than trusting what the page showed.

import type { SupabaseClient } from "@supabase/supabase-js";

export type EmailHold =
  | { kind: "missing" }
  | { kind: "not-member" }
  | { kind: "not-review"; title: string; status: string }
  | { kind: "held"; articleId: string; title: string; domain: string | null }
  | { kind: "ready"; articleId: string; title: string; domain: string | null; holder: string };

/**
 * What a hold link for `articleId`, signed for `email`, would do now. The
 * signature has already been checked (readHoldParams); this checks the
 * address still belongs to a member of the article's account and the draft is
 * still one the rule could approve.
 */
export async function resolveEmailHold(
  supabase: SupabaseClient,
  articleId: string,
  email: string,
): Promise<EmailHold> {
  const { data: article } = await supabase
    .from("articles")
    .select("id, title, status, held_by, workspace_id, workspaces(account_id, domain)")
    .eq("id", articleId)
    .maybeSingle();
  if (!article) return { kind: "missing" };

  const ws = (Array.isArray(article.workspaces) ? article.workspaces[0] : article.workspaces) as
    | { account_id: string; domain: string | null }
    | null;

  // The link's address must belong to a member of the article's account. The
  // addresses live in auth.users, which PostgREST does not expose, so this is
  // the same walk accountRecipients makes, in reverse: one lookup per member
  // until the address matches.
  let holder: string | null = null;
  if (ws) {
    const { data: members } = await supabase.from("account_members").select("user_id").eq("account_id", ws.account_id);
    for (const m of members ?? []) {
      const { data } = await supabase.auth.admin.getUserById(m.user_id as string);
      if (data?.user?.email?.trim().toLowerCase() === email) {
        holder = m.user_id as string;
        break;
      }
    }
  }
  if (!holder) return { kind: "not-member" };

  const title = (article.title as string) || "this draft";
  if (article.status !== "review") return { kind: "not-review", title, status: String(article.status) };
  const domain = ws?.domain ?? null;
  if (article.held_by) return { kind: "held", articleId: article.id as string, title, domain };
  return { kind: "ready", articleId: article.id as string, title, domain, holder };
}

/** Record the hold against the member. Matches nothing if it changed meanwhile. */
export async function applyEmailHold(
  supabase: SupabaseClient,
  hold: Extract<EmailHold, { kind: "ready" }>,
): Promise<{ error: string | null }> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("articles")
    .update({
      held_by: hold.holder,
      held_at: now,
      auto_approve_hold_reason: "held by a person",
      updated_at: now,
    })
    .eq("id", hold.articleId)
    .eq("status", "review")
    .is("held_by", null);
  return { error: error?.message ?? null };
}
