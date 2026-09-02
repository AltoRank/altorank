import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { PageHead, StatusPill, Icons, Button, Card } from "@/components/ui";
import { PLAN_LABELS, PLAN_PRICES, type PlanTier } from "@/lib/stripe";
import { getSimulation } from "@/lib/dev/simulation";
import { getQuota } from "@/lib/billing/quota";
import { BillingActions } from "./billing-actions";
import { SettingsTabs } from "../settings-tabs";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage(props: { searchParams?: Promise<{ return?: string; upgraded?: string }> }) {
  const returnTo = (await props.searchParams)?.return;
  const { agencyId, user } = await requireAuth();
  const supabase = await createClient();

  const { data: agency } = await supabase
    .from("agencies")
    .select("plan, plan_status, current_period_end, stripe_customer_id")
    .eq("id", agencyId)
    .single();

  const { data: invoices } = await supabase
    .from("invoices")
    .select("number, period, articles, amount, status, pdf_url")
    .eq("agency_id", agencyId)
    .order("created_at", { ascending: false })
    .limit(12);

  // Dev-only: the simulator cookie can stand in for a plan the local DB
  // does not have, so each tier's billing view is checkable before Stripe
  // is even configured. Null everywhere outside development.
  const simulation = await getSimulation();
  const plan = (simulation?.plan ?? agency?.plan ?? "starter") as PlanTier;
  const status = agency?.plan_status ?? "inactive";

  const quota = await getQuota(supabase, agencyId, user.email ?? null);
  const isActive = Boolean(simulation?.plan) || status === "active" || status === "trialing";
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

          <Card title="Plan">
            <div className="flex items-start justify-between gap-6 flex-wrap">
              <div className="text-[13px] text-ink-2 max-w-[460px] pt-1">
                {isActive ? (
                  <>
                    You&rsquo;re on the{" "}
                    <span className="font-medium text-ink">{PLAN_LABELS[plan]}</span> plan
                    {" "}({PLAN_PRICES[plan]}{plan !== "scale" ? "/mo" : ""}).
                  </>
                ) : (
                  // `plan` defaults to "starter" when the row is empty, and the
                  // old copy presented that default as a fact: "You're on the
                  // Managed plan. Subscribe to activate." Nobody is on a plan
                  // they have not bought.
                  <>No plan yet. Pick one below, or self-host free.</>
                )}
              </div>
              <BillingActions hasCustomer={!!agency?.stripe_customer_id} returnTo={returnTo} />
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
