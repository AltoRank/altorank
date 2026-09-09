// ---------------------------------------------------------------------------
// "X approved this draft"
// ---------------------------------------------------------------------------
//
// Kept out of app/actions/publish.ts because of the client it needs. The
// approve action runs on a cookie-bound Supabase client, where `auth.admin`
// throws - and `accountRecipients` resolves addresses through
// `auth.admin.getUserById`. So the notification uses the service client, while
// the approval itself stays under RLS as it must.
//
// The email goes to everyone with access to that site, including the person
// who pressed the button. That is deliberate: `sendOnce` deduplicates by
// recipient, and dropping the actor would mean an owner who approves their own
// drafts has no record of them in the inbox at all. The one place we do skip
// the actor is where the action is on their screen as it happens - a manual
// publish - and approval is not that: what it announces is the state the
// article is now in for everybody else.

import type { User } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { notifyDraftApproved } from "./lifecycle";
import { describeSendOutcome } from "./send-once";

type ApprovedRow = {
  id: string;
  title: string | null;
  keyword: string | null;
  scheduled_at: string | null;
  workspace_id: string;
  workspaces: { domain: string | null; account_id: string } | null;
};

/** How the account knows this person: their name if they gave one, else their address. */
export function actorName(user: Pick<User, "email" | "user_metadata">): string {
  const meta = user.user_metadata as { full_name?: string; name?: string } | null;
  return meta?.full_name?.trim() || meta?.name?.trim() || user.email || "A team member";
}

/**
 * Announce an approval. Never throws: the article is already approved and
 * recorded, and a mail problem must not turn that into a failed action the
 * reviewer has to repeat.
 */
export async function announceDraftApproved(
  articleId: string,
  user: Pick<User, "email" | "user_metadata">,
): Promise<string> {
  try {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from("articles")
      .select("id, title, keyword, scheduled_at, workspace_id, workspaces(domain, account_id)")
      .eq("id", articleId)
      .maybeSingle();
    if (!data) return "";

    const row = data as unknown as Omit<ApprovedRow, "workspaces"> & {
      workspaces: ApprovedRow["workspaces"] | ApprovedRow["workspaces"][];
    };
    const workspace = Array.isArray(row.workspaces) ? (row.workspaces[0] ?? null) : row.workspaces;
    if (!workspace) return "";

    const out = await notifyDraftApproved(
      supabase,
      { accountId: workspace.account_id, workspaceId: row.workspace_id },
      {
        domain: workspace.domain,
        title: row.title ?? "Your article",
        keyword: row.keyword,
        articleId: row.id,
        approvedBy: actorName(user),
        // Only a date the article itself carries. The workspace cadence knows
        // a weekday and a time, not a date, and guessing one on an email that
        // an account may forward to a client is the wrong place to be wrong.
        scheduledFor: row.scheduled_at,
      },
    );
    return describeSendOutcome(out);
  } catch (err) {
    console.error(`[approve] email for ${articleId}: ${err instanceof Error ? err.message : err}`);
    return "";
  }
}
