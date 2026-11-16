"use server";

import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { readWhyParams } from "@/lib/email/why-link";
import { gateAnswerNote, isGateReason } from "@/lib/onboarding/gate-answer";
import { recordGateAnswer, resolveWhyAsker } from "@/lib/onboarding/gate-answer-store";

/**
 * The write behind /why's buttons. The hidden fields come from the browser,
 * so the form is exactly as forgeable as the URL was: the signature is
 * checked again here, and so is who the address belongs to.
 */
export async function answerWhy(formData: FormData): Promise<void> {
  const w = String(formData.get("w") ?? "");
  const e = String(formData.get("e") ?? "");
  const s = String(formData.get("s") ?? "");
  const reason = formData.get("reason");
  const back = `/why?w=${encodeURIComponent(w)}&e=${encodeURIComponent(e)}&s=${encodeURIComponent(s)}`;
  const parsed = readWhyParams(new URLSearchParams({ w, e, s }));
  if (!parsed.ok || !isGateReason(reason)) redirect(back);

  const db = createServiceClient();
  const asker = await resolveWhyAsker(db, parsed.workspaceId, parsed.email);
  if (asker.kind !== "ready") redirect(back);
  await recordGateAnswer(db, {
    workspaceId: asker.workspaceId,
    accountId: asker.accountId,
    userId: asker.userId,
    reason,
    via: "email",
    note: gateAnswerNote(formData.get("note")),
  });
  redirect(`${back}&done=1`);
}
