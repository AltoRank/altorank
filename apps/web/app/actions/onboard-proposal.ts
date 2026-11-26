"use server";

// ---------------------------------------------------------------------------
// "Write this": the owner accepts the first article a first look proposed
// ---------------------------------------------------------------------------
//
// Who may: an owner or an admin of the site's account, on their own session,
// never an operator viewing as them. What it does is in
// lib/onboarding/proposal.ts.

import { after } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { refusedWhileViewingAs } from "@/lib/auth/impersonation";
import { acceptProposal, type ProposalAnswer } from "@/lib/onboarding/proposal";

export async function writeProposedTopic(workspaceId: string): Promise<ProposalAnswer> {
  let role: string;
  try {
    ({ role } = await requireAuth(undefined, { workspaceId }));
  } catch {
    return { ok: false, message: "Sign in again to continue." };
  }
  if (role !== "owner" && role !== "admin") return { ok: false, message: "Only the account's owner or an admin can start an article." };
  // Writing it spends the customer's one article before the trial.
  const viewing = await refusedWhileViewingAs("Writing the proposed article");
  if (viewing) return { ok: false, message: viewing };
  return acceptProposal(createServiceClient(), workspaceId, { keepAlive: (work) => after(() => work) });
}
