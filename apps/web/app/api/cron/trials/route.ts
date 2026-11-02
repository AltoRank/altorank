import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { observedCron } from "@/lib/observability/cron";
import { describe as describeError } from "@/lib/observability/event";
import { notifyCardlessTrialEnded, notifyCardlessTrialEnding } from "@/lib/email/lifecycle";
import { PLAN_PRICES } from "@/lib/stripe";

export const maxDuration = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily: the trials with no card (lib/billing/cardless-trial.ts), which no
 * Stripe event speaks for.
 *
 *   ending in 2 days   the ask for the card, by email, once per trial
 *   ended              `plan_status` back to `inactive`, so the row stops
 *                      reading as a trial anywhere it is counted, and the
 *                      Free email, once
 *
 * Entitlement never waited for this: planEntitled closes a trial on its end
 * date (lib/billing/dunning.ts). This tidies the row and says so.
 */
async function run(request: Request): Promise<Response> {
  if (!isAuthorizedCron(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createServiceClient();
  const now = Date.now();
  const planPrice = `${PLAN_PRICES.starter}/month`;

  const { data: trials, error } = await supabase
    .from("accounts")
    .select("id, trial_ends_at")
    .eq("plan_status", "trialing")
    .is("stripe_subscription_id", null)
    .eq("billing_provider", "stripe")
    .not("trial_ends_at", "is", null)
    .lte("trial_ends_at", new Date(now + 2 * DAY_MS).toISOString())
    .limit(500);
  if (error) throw new Error(`could not list card-less trials (${error.message})`);

  let reminded = 0;
  let ended = 0;
  const failed: Array<{ account: string; error: string }> = [];
  for (const row of trials ?? []) {
    const accountId = row.id as string;
    const endsAt = row.trial_ends_at as string;
    try {
      if (Date.parse(endsAt) > now) {
        const out = await notifyCardlessTrialEnding(supabase, accountId, { endsAt, planPrice });
        if (out.sent > 0) reminded++;
        continue;
      }
      // Conditional: a card added since the list was read has written a
      // subscription id, and that row is the webhook's now.
      const { data: closed, error: closeError } = await supabase
        .from("accounts")
        .update({ plan_status: "inactive" })
        .eq("id", accountId)
        .eq("plan_status", "trialing")
        .is("stripe_subscription_id", null)
        .select("id");
      if (closeError) throw new Error(closeError.message);
      if ((closed ?? []).length) {
        ended++;
        await notifyCardlessTrialEnded(supabase, accountId, { endsAt, planPrice });
      }
    } catch (err) {
      failed.push({ account: accountId, error: describeError(err) });
    }
  }
  return NextResponse.json({ reminded, ended, failed });
}

export const GET = observedCron("cron.trials", run);
