import type { Metadata } from "next";
import { OutputForm } from "@/components/settings/output-form";
import { SettingsShell, NoWorkspaceCard } from "../settings-shell";
import { getWorkspaceSettings } from "@/lib/settings/workspace-settings";

export const metadata: Metadata = { title: "Article settings" };

export default async function ArticleSettingsPage() {
  const ws = await getWorkspaceSettings();
  return (
    <SettingsShell
      title="Articles"
      subtitle={<span>{ws ? `${ws.domain} · ` : ""}how drafts read, and who decides a draft ships</span>}
    >
      {ws ? <OutputForm workspaceId={ws.id} initial={ws.output} /> : <NoWorkspaceCard />}
    </SettingsShell>
  );
}
