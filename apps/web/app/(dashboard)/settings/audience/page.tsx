import type { Metadata } from "next";
import { AudienceForm } from "@/components/settings/audience-form";
import { SettingsShell, NoWorkspaceCard } from "../settings-shell";
import { getWorkspaceSettings } from "@/lib/settings/workspace-settings";

export const metadata: Metadata = { title: "Audience & Competitors" };

export default async function AudienceSettingsPage() {
  const ws = await getWorkspaceSettings();
  return (
    <SettingsShell
      title="Audience & Competitors"
      subtitle={<span>{ws ? `${ws.domain} · ` : ""}who you sell to, and who you sell against</span>}
    >
      {ws ? <AudienceForm workspaceId={ws.id} initial={ws.profile} /> : <NoWorkspaceCard />}
    </SettingsShell>
  );
}
