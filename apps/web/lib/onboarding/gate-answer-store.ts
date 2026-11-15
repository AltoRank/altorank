// ---------------------------------------------------------------------------
// Keeping an answer to "what stopped you?"
// ---------------------------------------------------------------------------
//
// The pick is an onboarding step (`gate_answer`), so it sits in the funnel
// beside `offer_seen` and is kept once per site: the first answer is the one
// that counts. What the person typed is its own event, kept every time,
// because a second sentence is more to read, not a second vote.
//
// Server-only: called by the gate's action (app/actions/gate-answer.ts) and
// by /why's POST (app/why/actions.ts), each after its own check of who is asking.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordEvent } from "@/lib/observability/record";
import { recordOnboardingStep, stepEventId } from "./step-events";
import type { GateAnswerVia, GateReason } from "./step-props";
import { GATE_REASON_LABELS } from "./gate-answer";

export const GATE_ANSWER_NOTE_SOURCE = "onboarding.gate_answer";

export async function recordGateAnswer(
  db: SupabaseClient,
  input: { workspaceId: string; accountId: string | null; userId: string | null; reason: GateReason; via: GateAnswerVia; note?: string | null },
): Promise<void> {
  await recordOnboardingStep(db, {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    userId: input.userId,
    step: "gate_answer",
    props: { reason: input.reason, via: input.via },
  });
  if (!input.note) return;
  await recordEvent(
    {
      level: "info",
      source: GATE_ANSWER_NOTE_SOURCE,
      message: `Why the trial was not started (${GATE_REASON_LABELS[input.reason]}): ${input.note}`,
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      context: { reason: input.reason, via: input.via },
    },
    db,
  );
}

/** Which of these sites have answered. A failed read is "none", so the question is asked again, never lost. */
export async function gateAnswered(db: SupabaseClient, workspaceIds: readonly string[]): Promise<Set<string>> {
  const byEvent = new Map(workspaceIds.map((id) => [stepEventId(id, "gate_answer"), id]));
  if (byEvent.size === 0) return new Set();
  const { data, error } = await db.from("system_events").select("id").in("id", [...byEvent.keys()]);
  if (error) return new Set();
  return new Set((data ?? []).map((row) => byEvent.get(row.id as string)).filter((id): id is string => Boolean(id)));
}

export type WhyAsker =
  | { kind: "missing" }
  | { kind: "not-member" }
  | { kind: "ready"; workspaceId: string; accountId: string; userId: string; domain: string | null };

/**
 * Whose answer a /why link is: the member of the site's account whose
 * address the mail went to. Asked by the page and again by its POST, so the
 * write never trusts what the page showed. Addresses live in auth.users,
 * which PostgREST does not expose: one lookup per member until one matches,
 * the walk lib/publishing/hold-from-email.ts makes.
 */
export async function resolveWhyAsker(db: SupabaseClient, workspaceId: string, email: string): Promise<WhyAsker> {
  const { data: ws } = await db.from("workspaces").select("id, account_id, domain").eq("id", workspaceId).maybeSingle();
  if (!ws) return { kind: "missing" };
  const { data: members } = await db.from("account_members").select("user_id").eq("account_id", ws.account_id);
  for (const m of members ?? []) {
    const { data } = await db.auth.admin.getUserById(m.user_id as string);
    if (data?.user?.email?.trim().toLowerCase() === email) {
      return { kind: "ready", workspaceId: ws.id as string, accountId: ws.account_id as string, userId: m.user_id as string, domain: (ws.domain as string | null) ?? null };
    }
  }
  return { kind: "not-member" };
}
