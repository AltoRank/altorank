import type { Metadata } from "next";
import Link from "next/link";
import { Card, StatusPill } from "@/components/ui";
import { GoogleConnectButton } from "@/components/dashboard/google-connect-button";
import { SettingsShell, NoWorkspaceCard } from "../settings-shell";
import { getWorkspaceSettings } from "@/lib/settings/workspace-settings";

export const metadata: Metadata = { title: "Search Console" };

/**
 * One question, answered per workspace: is Search Console connected for this
 * site, and has anything arrived from it. The connect button is the same
 * OAuth flow Integrations uses; this tab is where the wizard's "connect later"
 * comes back to.
 */
export default async function SearchConsoleSettingsPage() {
  const ws = await getWorkspaceSettings();
  const lastDate = ws?.gscLastDate
    ? new Date(ws.gscLastDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : null;

  return (
    <SettingsShell
      title="Search Console"
      subtitle={
        ws ? (
          <>
            <StatusPill status={ws.gscConnected ? "on" : "setup"} label={ws.gscConnected ? "Connected" : "Not connected"} />
            <span>{ws.domain}</span>
          </>
        ) : undefined
      }
    >
      {!ws ? (
        <NoWorkspaceCard />
      ) : (
        <Card title="Google Search Console">
          <div className="grid gap-5 md:grid-cols-[1fr_260px]">
            <div className="text-[13px] leading-relaxed text-ink-2">
              <p className="m-0 mb-2 font-medium text-ink">Avoid suggesting keywords you already rank for.</p>
              <p className="m-0 mb-2">
                With Search Console connected, keyword research knows which queries already send this site
                clicks and skips them, and the dashboard plots real clicks instead of nothing. Nothing here is
                estimated: until a sync has run, the traffic chart stays empty and says so.
              </p>
              <p className="m-0 text-[12.5px] text-ink-3">
                {ws.gscConnected
                  ? lastDate
                    ? `Connected for ${ws.domain}. Newest day synced: ${lastDate}. Search Console reports with about a two-day lag.`
                    : `Connected for ${ws.domain}, and nothing has arrived yet. The first sync runs on the next schedule; if this stays empty, the connected Google account may not be able to see a property for this domain.`
                  : `Not connected for ${ws.domain}. Connecting sends you to Google, then back here.`}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <GoogleConnectButton integrationId="gsc" connected={ws.gscConnected} />
              <Link
                href="/connect/google"
                className="text-center text-[12px] text-accent-ink underline decoration-line underline-offset-[3px]"
              >
                See every site this Google account can read
              </Link>
            </div>
          </div>
        </Card>
      )}
    </SettingsShell>
  );
}
