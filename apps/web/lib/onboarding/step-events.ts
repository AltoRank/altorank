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
// step took, the seconds since signup when the gate was shown, and for the
// steps after the run a word from a closed list (./step-props.ts) and the
// article or run it was about. No email, no domain, no text.
//
// Most steps are kept once per workspace. A few are kept once per what tells
// them apart (`stepKey`): an ending, an article, a run, a checkout session.
//
// Server-only: the write uses the service role, like every system event. The
// browser reaches it through /api/onboard/step, which checks who is asking.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { buildEventRow } from "@/lib/observability/event";
import { STEP_EVENT_SOURCE, type OnboardingStepName } from "./step-names";
import { checkoutSessionOrUndefined, stepKey, stepProps, uuidOrUndefined, type RunTrigger, type StepProps } from "./step-props";

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
  /** For the article steps: which article. */
  articleId?: string | null;
  /** For `run_started`: which run. */
  runId?: string | null;
  /**
   * For the checkout steps: the account's Stripe Checkout Session, once it
   * has one (`ownedCheckoutSession`). Not `checkoutSession`: the event log
   * blanks any context key with "session" in its name
   * (lib/observability/event.ts), and the id is what ties a close to its try.
   */
  checkoutId?: string | null;
  /** The step's words from ./step-props.ts; anything off its lists is dropped. */
  props?: StepProps;
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
  const articleId = uuidOrUndefined(input.articleId);
  const runId = uuidOrUndefined(input.runId);
  const checkoutId = checkoutSessionOrUndefined(input.checkoutId);
  return {
    step: input.step,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(ms !== undefined ? { ms } : {}),
    ...(since !== undefined ? { secondsSinceSignup: since } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(articleId ? { articleId } : {}),
    ...(runId ? { runId } : {}),
    ...(checkoutId ? { checkoutId } : {}),
    ...stepProps(input.step, input.props),
  };
}

/**
 * The event's id: the same for one step of one workspace, every time. The
 * row's primary key is what makes "once" hold when two tabs or a reload say
 * the same step at the same moment - a read-then-write check would let both
 * through. A name-based UUID (version 5 layout) from a SHA-256 of the pair,
 * and of the step's key when it has one (`stepKey`); a step without one has
 * the id it always had.
 */
export function stepEventId(workspaceId: string, step: OnboardingStepName, key = ""): string {
  const hex = createHash("sha256").update(`${STEP_EVENT_SOURCE}:${workspaceId}:${step}${key ? `:${key}` : ""}`).digest("hex");
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
    const props = stepProps(input.step, input.props);
    const extra = [
      context.ms !== undefined ? `${((context.ms as number) / 1000).toFixed(1)}s` : null,
      context.secondsSinceSignup !== undefined ? `${context.secondsSinceSignup}s after signup` : null,
      ...Object.values(props).map((v) => String(v).replace(/_/g, " ")),
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
      .upsert(
        {
          id: stepEventId(
            input.workspaceId,
            input.step,
            stepKey(input.step, { articleId: context.articleId as string | undefined, runId: context.runId as string | undefined, checkoutId: context.checkoutId as string | undefined, props }),
          ),
          ...row,
        },
        { onConflict: "id", ignoreDuplicates: true },
      )
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

/**
 * The Stripe Checkout Session a browser named, when it is the one this
 * account has open (lib/billing/checkout-attempt.ts keeps one per account),
 * else undefined. Each session is its own key for the checkout steps, so a
 * made-up id would be a new row every time; only a real one of the account's
 * gets that far. Never throws: a failed read is no session.
 */
export async function ownedCheckoutSession(db: SupabaseClient, accountId: string, raw: unknown): Promise<string | undefined> {
  const session = checkoutSessionOrUndefined(raw);
  if (!session) return undefined;
  try {
    const { data, error } = await db.from("billing_checkout_attempts").select("stripe_session_id").eq("account_id", accountId).maybeSingle();
    if (error) return undefined;
    return (data as { stripe_session_id?: string | null } | null)?.stripe_session_id === session ? session : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `run_started` for a run just created: once per run, with what started it.
 * Without a trigger the site's other runs answer it: none is the site's
 * first, any is a run asked for again. A failed read leaves the trigger
 * out rather than guess. Never throws.
 */
export async function recordRunStarted(
  db: SupabaseClient,
  input: { workspaceId: string; accountId: string | null; userId: string | null; runId: string; trigger?: RunTrigger },
): Promise<boolean> {
  try {
    let trigger = input.trigger;
    if (!trigger) {
      const { data, error } = await db.from("onboarding_runs").select("id").eq("workspace_id", input.workspaceId).neq("id", input.runId).limit(1);
      if (!error) trigger = (data ?? []).length > 0 ? "rerun" : "first";
    }
    return await recordOnboardingStep(db, { ...input, step: "run_started", props: trigger ? { trigger } : {} });
  } catch (err) {
    console.warn(`[onboarding.step] run_started: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * `trial_started`, from Stripe's webhook once the account is written as
 * trialing: once per site of the account, so the funnel reads it beside
 * that site's gate. Stripe delivers an event more than once; the id keeps
 * it once. Never throws.
 */
export async function recordTrialStarted(
  db: SupabaseClient,
  input: { accountId: string; workspaceIds: string[]; plan?: string | null },
): Promise<void> {
  const props = stepProps("trial_started", { plan: input.plan });
  for (const workspaceId of [...new Set(input.workspaceIds)]) {
    await recordOnboardingStep(db, { workspaceId, accountId: input.accountId, userId: null, step: "trial_started", props });
  }
}

/**
 * `article_approved` for each approval just written: once per article, the
 * first time. `approved_at` cannot stand in for it: an edit clears it, and
 * an approved-then-edited article reads as never approved. Never throws.
 */
export async function recordArticlesApproved(
  db: SupabaseClient,
  approved: Array<{ id: string; workspaceId: string; status: "approved" | "scheduled" }>,
  userId: string | null,
): Promise<void> {
  if (!approved.length) return;
  // The account is for /admin/events' filter; without it the event still stands.
  const accountOf = new Map<string, string>();
  try {
    const sites = [...new Set(approved.map((a) => a.workspaceId))];
    const { data } = await db.from("workspaces").select("id, account_id").in("id", sites);
    for (const w of (data ?? []) as Array<{ id: string; account_id: string }>) accountOf.set(w.id, w.account_id);
  } catch (err) {
    console.warn(`[onboarding.step] article_approved: could not read the accounts (${err instanceof Error ? err.message : String(err)})`);
  }
  for (const a of approved) {
    await recordOnboardingStep(db, {
      workspaceId: a.workspaceId,
      accountId: accountOf.get(a.workspaceId) ?? null,
      userId,
      step: "article_approved",
      articleId: a.id,
      props: { status: a.status },
    });
  }
}
