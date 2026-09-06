import type { Metadata } from "next";
import { SiteForm } from "@/components/settings/site-form";
import { SettingsShell, NoWorkspaceCard } from "../settings-shell";
import { getWorkspaceSettings } from "@/lib/settings/workspace-settings";

export const metadata: Metadata = { title: "Blog settings" };

export default async function BlogSettingsPage() {
  const ws = await getWorkspaceSettings();
  return (
    <SettingsShell
      title="Blog"
      subtitle={<span>{ws ? `${ws.domain} · ` : ""}sitemap, blog address and the writing drafts learn from</span>}
    >
      {ws ? <SiteForm workspaceId={ws.id} domain={ws.domain} initial={ws.site} /> : <NoWorkspaceCard />}
    </SettingsShell>
  );
}
