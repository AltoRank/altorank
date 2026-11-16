"use server";

// The gate's "what stopped you?" (components/onboarding/gate-question.tsx).
// Any member of the site's account may answer; an operator viewing as the
// account is not that account, and writes nothing.

import { createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getImpersonation } from "@/lib/auth/impersonation";
import { gateAnswerNote, isGateReason } from "@/lib/onboarding/gate-answer";
import { recordGateAnswer } from "@/lib/onboarding/gate-answer-store";

export async function answerGate(workspaceId: string, reason: string, note?: string): Promise<{ ok: boolean }> {
  if (!isGateReason(reason)) return { ok: false };
  const { user, accountId } = await requireAuth(undefined, { workspaceId });
  if (await getImpersonation().catch(() => null)) return { ok: true };
  await recordGateAnswer(createServiceClient(), { workspaceId, accountId, userId: user.id, reason, via: "gate", note: gateAnswerNote(note) });
  return { ok: true };
}
