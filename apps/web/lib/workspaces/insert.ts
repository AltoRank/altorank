// ---------------------------------------------------------------------------
// A new site is written by the server, after the allowance has answered
// ---------------------------------------------------------------------------
//
// The site allowance (lib/billing/workspaces.ts: one site before a plan) was
// checked by createWorkspace and then the row was inserted through the
// person's own client - and the policy that let that insert through let any
// insert through. So the same person could POST twenty rows straight to
// /rest/v1/workspaces and skip the allowance, the domain check and the
// duplicate check (round-4 review: INSERT 0 20). Every site costs a first
// look and can be set up, so the allowance is a spend limit, not a label.
//
// Migration 100 takes INSERT on `workspaces` away from client tokens. The
// actions that add a site - createWorkspace and the Search Console import -
// write it here, with the service role, once they have checked everything
// the policy used to check: the caller is an owner or admin of this account
// and sees all of its sites (the policy's `user_full_access_account_ids()`).
// Signup already inserts with the service role.
//
// Works the same with or without 100 applied: the service role could always
// insert.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { canAddWorkspace } from "@/lib/team/access";

export type InsertWorkspaceResult = { ok: true; id: string } | { ok: false; error: string };

export const ADD_SITE_ROLE_MESSAGE =
  "Adding a workspace changes what the account pays for, so an owner or admin has to do it. Ask one of them and it takes a moment.";

/**
 * Insert one site for `accountId`, for the signed-in `userId`.
 *
 * `asCaller` is the person's own client, used only to read their membership
 * (RLS shows a person their own rows). The allowance, the domain and the
 * duplicate checks stay with the caller, which has already made them.
 */
export async function insertWorkspaceAsServer(
  asCaller: SupabaseClient,
  userId: string,
  accountId: string,
  row: Record<string, unknown>,
): Promise<InsertWorkspaceResult> {
  const { data: member, error: memberError } = await asCaller
    .from("account_members")
    .select("role, workspace_ids")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) return { ok: false, error: `Could not check your access to this account: ${memberError.message}` };
  // Full access, as the insert policy required: every site of the account,
  // not a slice of them.
  if (!member || !canAddWorkspace(member.role as string) || member.workspace_ids !== null) {
    return { ok: false, error: ADD_SITE_ROLE_MESSAGE };
  }

  const { data, error } = await createServiceClient()
    .from("workspaces")
    .insert({ ...row, account_id: accountId })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "The workspace could not be created." };
  return { ok: true, id: data.id as string };
}
