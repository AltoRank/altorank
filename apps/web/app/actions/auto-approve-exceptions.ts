"use server";

// ---------------------------------------------------------------------------
// Which exception rules a site turns off (migration 119)
// ---------------------------------------------------------------------------
//
// The column is server-written: a signed-in client that changes it is
// refused by workspaces_guard_auto_approve_exceptions. This action checks
// who is asking and, for health, legal and money advice, that the site has
// the clean approvals D5 asks for, then writes with the service client.

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/require-auth";
import { canAddWorkspace } from "@/lib/team/access";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  CLEAN_APPROVALS_FOR_SENSITIVE,
  OPT_OUT_RULES,
  isCleanApproval,
  type ApprovalRow,
  type OptOutRule,
} from "@/lib/publishing/auto-approve-exceptions";

/**
 * Save which rules are off. `off` lists the rules to turn off; every other
 * rule is on. Owners and admins only: it decides what ships unread.
 */
export async function setAutoApproveExceptions(workspaceId: string, off: OptOutRule[]): Promise<void> {
  const { accountId, role } = await requireAuth(undefined, { workspaceId });
  if (!canAddWorkspace(role)) throw new Error("Only an owner or an admin can change what autopilot asks about.");

  const wanted = new Set(off.filter((r): r is OptOutRule => (OPT_OUT_RULES as readonly string[]).includes(r)));
  if (wanted.has("sensitive")) {
    // Read with the person's own token: what they can see is what counts.
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("articles")
      .select("status, approval_kind, approved_at, published_at, person_edited_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "live")
      .eq("approval_kind", "human");
    if (error) throw new Error(error.message);
    const clean = ((data ?? []) as ApprovalRow[]).filter(isCleanApproval).length;
    if (clean < CLEAN_APPROVALS_FOR_SENSITIVE) {
      throw new Error(
        `Health, legal and money advice can be turned off after ${CLEAN_APPROVALS_FOR_SENSITIVE} approvals that went out unedited; this site has ${clean}.`,
      );
    }
  }

  const value = Object.fromEntries([...wanted].map((r) => [r, false]));
  const { data: written, error } = await createServiceClient()
    .from("workspaces")
    .update({ auto_approve_exceptions: value })
    .eq("id", workspaceId)
    .eq("account_id", accountId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!written?.length) throw new Error("Workspace not found");

  revalidatePath(`/workspaces/${workspaceId}`);
}
