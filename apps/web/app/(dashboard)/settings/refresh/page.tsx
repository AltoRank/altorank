import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { RefreshSettingsForm } from "@/components/dashboard/refresh-settings-form";
import { SettingsTabs } from "../settings-tabs";

export const metadata: Metadata = { title: "Improvements settings" };

/**
 * Per-site: the switch and the weekdays for scheduled rewrites. Scoped to the
 * workspace the sidebar switcher is on, like every other site-level control.
 */
export default async function RefreshSettingsPage() {
  const scopeId = await getScopedWorkspaceId();
  const supabase = await createClient();
  const { data: ws } = scopeId
    ? await supabase
        .from("workspaces")
        .select("id, name, domain, refresh_enabled, refresh_days")
        .eq("id", scopeId)
        .maybeSingle()
    : { data: null };

  return (
    <>
      <PageHead
        title="Settings"
        subtitle={<span>{ws ? `Scheduled rewrites for ${ws.domain ?? ws.name}` : "Scheduled rewrites"}</span>}
      />
      <SettingsTabs />
      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <div className="max-w-[560px]">
          {ws ? (
            <RefreshSettingsForm
              workspaceId={ws.id as string}
              domain={(ws.domain as string | null) ?? null}
              enabled={Boolean(ws.refresh_enabled)}
              days={((ws.refresh_days as number[] | null) ?? []).filter((d) => Number.isInteger(d))}
            />
          ) : (
            <p className="text-[13px] text-ink-3">
              No site selected. <Link href="/workspaces" className="underline">Add one</Link> to schedule rewrites.
            </p>
          )}
          <p className="mt-4 text-[12.5px] text-ink-3">
            Candidates, briefs and reviews live on the{" "}
            <Link href="/improvements" className="underline decoration-line underline-offset-2">
              Improvements
            </Link>{" "}
            page.
          </p>
        </div>
      </div>
    </>
  );
}
