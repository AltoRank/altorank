// ---------------------------------------------------------------------------
// Where a signup got to, step by step, in system_events
// ---------------------------------------------------------------------------
//
// The run row says what the pipeline did; nothing said what the person did
// around it - how long the wizard's site read took, whether the gate was
// ever shown, whether the trial button was pressed and checkout came back.
// One `onboarding.step` event per step per workspace (the first time it is
// reached; a reload or a second run does not add another), readable on
// /admin/events. Ids and timings only: the step, the milliseconds a timed
// step took, the seconds since signup when the gate was shown. No email, no
// domain, no text.
//
// Server-only: the write uses the service role, like every system event. The
// browser reaches it through /api/onboard/step, which checks who is asking.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { buildEventRow } from "@/lib/observability/event";
import { STEP_EVENT_SOURCE, type OnboardingStepName } from "./step-names";

export interface StepEventInput {
  workspaceId: string;
  accountId: string | null;
  userId: string | null;
  step: OnboardingStepName;
  /** How long a timed step took (the site read). */
  ms?: number | null;
  /** For `gate_shown`: seconds from the account's signup to the gate. */
  secondsSinceSignup?: number | null;
  /** For `competitor_step_done`: how many competitors were named. */
  count?: number | null;
}

/** A bounded non-negative integer, or undefined. */
function whole(value: unknown, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(max, Math.round(n));
}

/** The event's context: the step and its numbers, nothing else. Pure. */
export function stepContext(input: StepEventInput): Record<string, unknown> {
  const ms = whole(input.ms, 3_600_000);
  const since = whole(input.secondsSinceSignup, 365 * 86_400);
  const count = whole(input.count, 1_000);
  return {
    step: input.step,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(ms !== undefined ? { ms } : {}),
    ...(since !== undefined ? { secondsSinceSignup: since } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}

/**
 * The event's id: the same for one step of one workspace, every time. The
 * row's primary key is what makes "once" hold when two tabs or a reload say
 * the same step at the same moment - a read-then-write check would let both
 * through. A name-based UUID (version 5 layout) from a SHA-256 of the pair.
 */
export function stepEventId(workspaceId: string, step: OnboardingStepName): string {
  const hex = createHash("sha256").update(`${STEP_EVENT_SOURCE}:${workspaceId}:${step}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Record a step once per workspace. Resolves `true` when this call wrote it,
 * `false` when it was already there or could not be written. Never throws.
 */
export async function recordOnboardingStep(db: SupabaseClient, input: StepEventInput): Promise<boolean> {
  try {
    const context = stepContext(input);
    const extra = [
      context.ms !== undefined ? `${((context.ms as number) / 1000).toFixed(1)}s` : null,
      context.secondsSinceSignup !== undefined ? `${context.secondsSinceSignup}s after signup` : null,
    ].filter(Boolean).join(", ");
    const row = buildEventRow({
      level: "info",
      source: STEP_EVENT_SOURCE,
      message: `Onboarding step: ${input.step.replace(/_/g, " ")}${extra ? ` (${extra})` : ""}`,
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      context,
    });
    const { data, error } = await db
      .from("system_events")
      .upsert({ id: stepEventId(input.workspaceId, input.step), ...row }, { onConflict: "id", ignoreDuplicates: true })
      .select("id");
    if (error) {
      console.warn(`[onboarding.step] could not record ${input.step}: ${error.message}`);
      return false;
    }
    return (data ?? []).length > 0;
  } catch (err) {
    console.warn(`[onboarding.step] ${input.step}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
