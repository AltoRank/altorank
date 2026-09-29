// ---------------------------------------------------------------------------
// A trial cancel, from the signed Stripe event to the drafting doors, on the
// local database
// ---------------------------------------------------------------------------
//
// The unit tests stub the quota. This runs the real chain: a signed
// `customer.subscription.updated` through the webhook route writes
// `accounts.cancels_at`, `getQuota` reads it back through PostgREST, and the
// spend gate, the crons' `draftBlocker` and `generateArticle` refuse - with no
// article row written. Then "Keep my plan" (the same event with the
// cancellation undone) opens drafting again, and a paid plan set to cancel at
// period end drafts on. The trial gate is read the same way for the held
// drafts digest, against an account that has not started its trial.
//
// Billing is switched on with a dummy secret key that never leaves the
// process: nothing below calls Stripe (constructEvent verifies the signature
// locally), and the loopback network guard would refuse it if anything did.
// Seeds one trialing account and one gated account with invented names and
// deletes both at the end.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";

process.env.STRIPE_SECRET_KEY = "sk_test_dummy_never_sent";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_trial_cancel_test";
delete process.env.TRIAL_GATE_DISABLED;

const STACK = await connectLocalStack();

const { createServiceClient } = await import("@/lib/supabase/server");
const { getQuota } = await import("@/lib/billing/quota");
const { canSpend } = await import("@/lib/billing/spend-gate");
const { draftBlocker, TrialHoldError } = await import("@/lib/billing/trial-hold");
const { generateArticle } = await import("@/lib/content/generate");
const { sendHeldDigests, GATED_DIGEST_LINE } = await import("@/lib/email/held-digest");
const { trialCancelledMessage } = await import("@/lib/billing/trial-refusal");

const RUN = `trial-cancel-${Date.now().toString(36)}`;
const SUB = `sub_${RUN}`;
const TRIAL_END_S = Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60;
const TRIAL_END = new Date(TRIAL_END_S * 1000).toISOString();

let accountId = "";
let workspaceId = "";
let gatedAccountId = "";
let gatedWorkspaceId = "";

/** A signed subscription event, delivered to the real route. */
async function deliver(sub: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify({
    id: `evt_${RUN}_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type: "customer.subscription.updated",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: SUB,
        object: "subscription",
        customer: `cus_${RUN}`,
        status: "trialing",
        trial_end: TRIAL_END_S,
        current_period_end: TRIAL_END_S,
        items: { data: [] },
        metadata: { account_id: accountId },
        pause_collection: null,
        ...sub,
      },
      previous_attributes: {},
    },
  });
  const header = new Stripe("sk_test_dummy_never_sent").webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  const { POST } = await import("@/app/api/webhooks/stripe/route");
  return POST(new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": header }, body: payload }));
}

describe.skipIf(!STACK)("a trial cancel on the local database", () => {
  let db: ReturnType<typeof createServiceClient>;

  beforeAll(async () => {
    db = createServiceClient();
    const { data: account, error } = await db
      .from("accounts")
      .insert({
        name: "Acme Agency (trial cancel test)",
        slug: RUN,
        plan: "starter",
        plan_status: "trialing",
        trial_ends_at: TRIAL_END,
        stripe_customer_id: `cus_${RUN}`,
        stripe_subscription_id: SUB,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    accountId = account.id as string;
    const { data: ws, error: wsError } = await db
      .from("workspaces")
      .insert({ account_id: accountId, name: "acme-agency.example", domain: "acme-agency.example" })
      .select("id")
      .single();
    if (wsError) throw new Error(wsError.message);
    workspaceId = ws.id as string;

    // Never trialed, no subscription: the account the trial gate holds.
    const { data: gated, error: gatedError } = await db
      .from("accounts")
      .insert({ name: "Acme Studio (trial cancel test)", slug: `${RUN}-gated` })
      .select("id")
      .single();
    if (gatedError) throw new Error(gatedError.message);
    gatedAccountId = gated.id as string;
    const { data: gws, error: gwsError } = await db
      .from("workspaces")
      .insert({ account_id: gatedAccountId, name: "acme-studio.example", domain: "acme-studio.example" })
      .select("id")
      .single();
    if (gwsError) throw new Error(gwsError.message);
    gatedWorkspaceId = gws.id as string;
  });

  afterAll(async () => {
    if (!db) return;
    for (const ws of [workspaceId, gatedWorkspaceId].filter(Boolean)) {
      await db.from("articles").delete().eq("workspace_id", ws);
      await db.from("workspaces").delete().eq("id", ws);
    }
    for (const id of [accountId, gatedAccountId].filter(Boolean)) await db.from("accounts").delete().eq("id", id);
  });

  const articleCount = async () => {
    const { count, error } = await db.from("articles").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    return count ?? 0;
  };

  it("drafts while the trial runs", async () => {
    const gate = await canSpend(db, accountId, { userEmail: null, workspaceId, action: "scheduled-work" });
    expect(gate).toMatchObject({ allowed: true, reason: "plan" });
  });

  it("records the cancel from the signed event, and every drafting door refuses it from then on", async () => {
    const res = await deliver({ cancel_at_period_end: true, cancel_at: TRIAL_END_S });
    expect(res.status).toBe(200);
    const { data: row } = await db.from("accounts").select("plan_status, cancels_at").eq("id", accountId).single();
    expect(row?.plan_status).toBe("trialing");
    expect(new Date(row?.cancels_at as string).toISOString()).toBe(TRIAL_END);

    const quota = await getQuota(db, accountId, null);
    expect(quota.reason).toBe("plan");
    const message = trialCancelledMessage(TRIAL_END);

    for (const action of ["scheduled-work", "draft", "refresh"] as const) {
      expect(await canSpend(db, accountId, { userEmail: null, workspaceId, action })).toMatchObject({ allowed: false, reason: "trial-cancelled", message });
    }
    // Reading and research stay open to the trial's end.
    expect(await canSpend(db, accountId, { userEmail: null, workspaceId, action: "keyword-research" })).toMatchObject({ allowed: true });
    expect(await draftBlocker(db, quota, workspaceId)).toBe(message);

    const before = await articleCount();
    const refused = await generateArticle({ supabase: db, workspaceId, keyword: "crm for agencies", autonomous: true, callerEmail: null }).catch((e) => e);
    expect(refused).toBeInstanceOf(TrialHoldError);
    expect((refused as Error).message).toBe(message);
    expect(await articleCount()).toBe(before);
  });

  it("opens drafting again when the cancel is undone", async () => {
    expect((await deliver({ cancel_at_period_end: false, cancel_at: null })).status).toBe(200);
    const { data: row } = await db.from("accounts").select("cancels_at").eq("id", accountId).single();
    expect(row?.cancels_at).toBeNull();
    expect(await canSpend(db, accountId, { userEmail: null, workspaceId, action: "scheduled-work" })).toMatchObject({ allowed: true, reason: "plan" });
  });

  it("keeps a paid plan set to cancel at period end drafting until that end", async () => {
    const periodEnd = TRIAL_END_S + 30 * 24 * 60 * 60;
    const res = await deliver({ status: "active", trial_end: null, current_period_end: periodEnd, cancel_at_period_end: true, cancel_at: periodEnd });
    expect(res.status).toBe(200);
    const { data: row } = await db.from("accounts").select("plan_status, cancels_at").eq("id", accountId).single();
    expect(row?.plan_status).toBe("active");
    expect(row?.cancels_at).not.toBeNull();
    for (const action of ["scheduled-work", "draft", "refresh"] as const) {
      expect(await canSpend(db, accountId, { userEmail: null, workspaceId, action })).toMatchObject({ allowed: true, reason: "plan" });
    }
    expect(await draftBlocker(db, await getQuota(db, accountId, null), workspaceId)).toBeNull();
  });

  it("sends no held-drafts digest to an account that has not started its trial", async () => {
    const lines = await sendHeldDigests(db, [
      { workspaceId: gatedWorkspaceId, articleId: "00000000-0000-4000-8000-000000000001", outcome: "held", detail: "no active plan" } as never,
    ]);
    expect(lines).toEqual([`${gatedWorkspaceId}: 1 held, ${GATED_DIGEST_LINE}`]);
    const { count } = await db.from("sent_emails").select("id", { count: "exact", head: true }).eq("workspace_id", gatedWorkspaceId);
    expect(count ?? 0).toBe(0);
  });
});
