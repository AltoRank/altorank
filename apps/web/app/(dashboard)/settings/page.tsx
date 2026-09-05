import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { getAgency } from "@/lib/queries/agency";
import { SettingsForm } from "@/components/dashboard/settings-form";
import { PasswordForm } from "@/components/dashboard/password-form";
import { AttributionCard } from "@/components/dashboard/attribution-card";
import { BusinessForm } from "@/components/settings/business-form";
import { SettingsShell, NoWorkspaceCard } from "./settings-shell";
import { createClient } from "@/lib/supabase/server";
import { getQuota } from "@/lib/billing/quota";
import { getWorkspaceSettings } from "@/lib/settings/workspace-settings";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const agency = await getAgency();

  if (!agency) {
    return <div className="p-8 text-ink-3">No account found. Please sign in.</div>;
  }

  // The white-label panel used to state, in fixed text, that branding is not
  // gated on any plan. It is now, for the hosted free tier only, so the panel
  // has to read the real answer (2026-09-02).
  const supabase = await createClient();
  const [quota, ws] = await Promise.all([getQuota(supabase, agency.id), getWorkspaceSettings()]);

  return (
    <SettingsShell
      title="Settings"
      subtitle={<span>{ws ? `${ws.domain} · ` : ""}business profile, account defaults, report branding and API access</span>}
    >
      {/* The site first, the account after: the wizard's first screen is the
          thing people come back to change, and it is about the workspace the
          switcher is on. */}
      {ws ? <BusinessForm workspaceId={ws.id} domain={ws.domain} initial={ws.profile} /> : <NoWorkspaceCard />}

      <SettingsForm agency={agency} quotaReason={quota.reason} />

      <AttributionCard source={agency.attribution_source ?? null} note={agency.attribution_note ?? null} />

      <Card title="Password">
        <PasswordForm />
      </Card>
    </SettingsShell>
  );
}
