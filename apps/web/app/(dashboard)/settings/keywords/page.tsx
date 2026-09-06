import type { Metadata } from "next";
import { KeywordPromptForm } from "@/components/settings/keyword-prompt-form";
import { SettingsShell, NoWorkspaceCard } from "../settings-shell";
import { getWorkspaceSettings } from "@/lib/settings/workspace-settings";

export const metadata: Metadata = { title: "Keyword settings" };

/**
 * TODO(keywords): the auto-plan and queue-floor toggles belong on this tab.
 * Their columns do not exist on this branch (checked workspace_output_settings
 * and workspaces on 2026-09-04) and another track owns them; render them here
 * once that migration lands rather than adding a second set of columns.
 */
export default async function KeywordSettingsPage() {
  const ws = await getWorkspaceSettings();
  return (
    <SettingsShell
      title="Keywords"
      subtitle={<span>{ws ? `${ws.domain} · ` : ""}what research should look for</span>}
    >
      {ws ? <KeywordPromptForm workspaceId={ws.id} initial={ws.keywordPrompt} /> : <NoWorkspaceCard />}
    </SettingsShell>
  );
}
