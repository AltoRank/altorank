import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { PageHead, StatusPill, Icons, Button, Card } from "@/components/ui";
import {
  PLAN_LABELS,
  PLAN_PRICES,
  PLAN_YEARLY_PRICES,
  PLAN_TAGLINES,
  PLAN_FEATURES,
  type PlanTier,
} from "@/lib/stripe";
import { getSimulation } from "@/lib/dev/simulation";
import { getOperatorPreview } from "@/lib/auth/preview";
import { getQuota } from "@/lib/billing/quota";
import { PlanCards, type PlanCard } from "./plan-cards";
import { SettingsTabs } from "../settings-tabs";

export const metadata: Metadata = { title: "Billing" };

const TIERS = ["starter", "growth", "scale"] as const satisfies readonly PlanTier[];

const PLAN_CARDS: PlanCard[] = TIERS.map((tier) => ({
  tier,
  label: PLAN_LABELS[tier],
  monthly: PLAN_PRICES[tier],
  yearly: PLAN_YEARLY_PRICES[tier],
  tagline: PLAN_TAGLINES[tier],
  features: PLAN_FEATURES[tier],
}));

export default async function BillingPage(props: { searchParams?: Promise<{ return?: string; upgraded?: string }> }) {
  const returnTo = (await props.searchParams)?.return;
  const { agencyId, user } = await requireAuth();
  const supabase = await createClient();

  // Five independent reads. Each needs only the agency and user requireAuth
  // just returned; none consumes another's result, and the plan and status
  // below are computed from them afterwards rather than between them. Awaited
  // one after the other they were five round trips on the page people open
  // when they are about to pay.
  const [{ data: agency }, { data: invoices }, simulation, preview, quota] =
    await Promise.all([
      supabase
        .from("agencies")
        .select("plan, plan_status, current_period_end, stripe_customer_id")
        .eq("id", agencyId)
        .single(),
      supabase
        .from("invoices")
        .select("number, period, articles, amount, status, pdf_url")
        .eq("agency_id", agencyId)
        .order("created_at", { ascending: false })
        .limit(12),
      // Dev-only: the simulator cookie can stand in for a plan the local DB
      // does not have, so each tier's billing view is checkable before Stripe
      // is even configured. Null everywhere outside development.
      getSimulation(),
      // The production preview overrides the same way the dev simulator does,
      // and takes precedence: if an operator asked to see the Managed screens,
      // showing them their real row instead answers a question they did not ask.
      getOperatorPreview(),
      getQuota(supabase, agencyId, user.email ?? null),
    ]);

  const plan = (preview?.plan ?? simulation?.plan ?? agency?.plan ?? "starter") as PlanTier;
  // The preview overrides the plan, so it has to override the status with it.
  // Reading the real row here produced "Managed plan · inactive" beside a card
  // badged "Your plan" - two contradictory answers to the same question, on
  // the screen whose whole job is to state what you are paying for.
  const status = preview?.plan ? "active" : (agency?.plan_status ?? "inactive");

  const isActive =
    Boolean(preview?.plan) || Boolean(simulation?.plan) || status === "active" || status === "trialing";
  const euros = (n: number | string | null) =>
    new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: 2,
    }).format(Number(n ?? 0));

  const renews = agency?.current_period_end
    ? new Date(agency.current_period_end).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <>
      <PageHead
        title="Billing"
        subtitle={
          <>
            <StatusPill
              status={isActive ? "on" : "setup"}
              label={isActive ? `${PLAN_LABELS[plan]} plan · ${status}` : "No plan"}
            />
            {isActive && (
              <span>
                {PLAN_PRICES[plan]}
                {plan !== "scale" ? " /mo" : ""}
                {renews ? ` · renews ${renews}` : ""}
              </span>
            )}
          </>
        }
      />

      <SettingsTabs />

      {/* Capped. These cards hold one line of copy and a row of buttons;
          left unbounded they stretch to the whole window, so on a wide
          display the plan sentence sits hard left and its buttons hard
          right with a thousand pixels of nothing between them, and the card
          reads as empty rather than as a sentence and its controls. 1140px
          is the width this page already had on a 1440 screen. */}
      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <div className="max-w-[1140px] space-y-6">
          <Card title="Usage this month">
            <div className="flex items-center justify-between gap-5 flex-wrap">
              <div className="text-[13px] text-ink-2">
                {quota.limit === null ? (
                  <>
                    <span className="font-mono font-semibold text-ink">{quota.used}</span>{" "}
                    articles generated. This account is unmetered
                    {quota.reason === "operator" ? " (operator)" : " (self-host)"}.
                  </>
                ) : (
                  <>
                    <span className="font-mono font-semibold text-ink">
                      {quota.limit === 0 ? quota.used : `${quota.used} / ${quota.limit}`}
                    </span>{" "}
                    {quota.limit === 0 ? "generated, no active plan." : "included articles used."}
                    {quota.used >= quota.limit &&
                      quota.reason === "plan" &&
                      " Additional articles bill at the published overage rate."}
                    {quota.reason === "no-plan" &&
                      " Subscribe to generate articles, or self-host free."}
                  </>
                )}
              </div>
              {quota.limit !== null && (
                <div className="w-[220px] h-1.5 rounded-full bg-panel-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${quota.used >= quota.limit ? "bg-err" : "bg-accent"}`}
                    style={{ width: `${Math.min(100, (quota.used / Math.max(1, quota.limit)) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          </Card>

          <Card title={isActive ? "Your plan" : "Choose a plan"} flush>
            <div className="p-[18px]">
              <PlanCards
                plans={PLAN_CARDS}
                /* Null unless something is actually being paid for: `plan`
                   defaults to "starter" on an empty row, and this page has
                   already once presented that default as a purchase. */
                currentTier={isActive ? plan : null}
                isActive={isActive}
                hasCustomer={!!agency?.stripe_customer_id}
                returnTo={returnTo}
              />
            </div>
          </Card>

          <Card title="Recent invoices" flush>
            {invoices && invoices.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] border-collapse text-[13px]">
                  <thead>
                    <tr>
                      {["Invoice", "Period", "Articles", "Amount", "Status", ""].map((h) => (
                        <th
                          key={h}
                          className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${
                            ["Articles", "Amount"].includes(h) ? "text-right" : "text-left"
                          }`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr key={inv.number} className="hover:[&>td]:bg-panel">
                        <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs">{inv.number}</td>
                        <td className="px-3.5 py-3 border-b border-line-soft">{inv.period}</td>
                        <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2 tabular-nums">{inv.articles}</td>
                        <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2 tabular-nums">{euros(inv.amount)}</td>
                        <td className="px-3.5 py-3 border-b border-line-soft">
                          <StatusPill status="on" label={inv.status ?? "—"} />
                        </td>
                        <td className="px-3.5 py-3 border-b border-line-soft">
                          {inv.pdf_url ? (
                            <a href={inv.pdf_url} target="_blank" rel="noopener noreferrer">
                              <Button size="sm"><Icons.download size={13} />PDF</Button>
                            </a>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-[13px] text-ink-3 italic p-[18px]">
                No invoices yet. They&rsquo;ll appear here after your first payment.
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
