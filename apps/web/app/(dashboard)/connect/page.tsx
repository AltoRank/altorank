import type { Metadata } from "next";
import Link from "next/link";
import { getIntegrations } from "@/lib/queries/integrations";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { PageHead, StatusPill, Button, Icons } from "@/components/ui";
import { ConnectActions } from "@/components/dashboard/connect-actions";
import { GoogleConnectButton } from "@/components/dashboard/google-connect-button";
import type { PublishingCadence } from "@/lib/types";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Integrations" };

const groups = ["CMS", "Analytics", "Data", "Notify", "Automate"];

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The integrations that have a real OAuth flow. Everything else still renders a
// disabled Connect button, because those need per-platform credential forms that
// do not exist yet, and a button that silently does nothing is worse than one
// that says it is unavailable.
const GOOGLE_INTEGRATIONS = new Set(["gsc", "ga4"]);

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  // The OAuth callback and the initiate route both redirect back here with
  // ?error= or ?success=. Nothing rendered them, so a failed connection looked
  // identical to never having clicked: the user landed on an unchanged page.
  const { error: oauthError, success: oauthSuccess } = await searchParams;
  const [integrations, workspaces] = await Promise.all([
    getIntegrations(),
    getWorkspaces(),
  ]);

  // Fetch all cadences for the user's workspaces
  const supabase = await createClient();
  const wsIds = workspaces.map((w) => w.id);
  const { data: cadencesData } = wsIds.length > 0
    ? await supabase
        .from("publishing_cadences")
        .select("*")
        .in("workspace_id", wsIds)
    : { data: [] };
  const cadences = (cadencesData ?? []) as PublishingCadence[];
  const enabledCadences = cadences.filter((c) => c.enabled);

  // Which integrations are already connected, for any of this agency's
  // workspaces. Used only to label the tile; connecting is per workspace.
  const { data: connectedRows } = wsIds.length > 0
    ? await supabase
        .from("workspace_integrations")
        .select("integration_id")
        .in("workspace_id", wsIds)
    : { data: [] };
  const connectedIds = new Set((connectedRows ?? []).map((r) => r.integration_id as string));

  return (
    <>
      <PageHead
        title="Integrations"
        subtitle={<><StatusPill status="on" label={`${integrations.length} available`} /><span>Connect the tools your sites already run on</span></>}
        actions={<ConnectActions workspaces={workspaces} integrations={integrations} />}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        {oauthError && (
          <div className="mb-5 rounded-[10px] border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            <strong className="font-semibold">Connection failed.</strong>{" "}
            {oauthError === "google_oauth_not_configured"
              ? "Google OAuth is not configured on this deployment. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI."
              : oauthError.replace(/_/g, " ")}
          </div>
        )}
        {oauthSuccess && (
          <div className="mb-5 rounded-[10px] border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-800">
            <strong className="font-semibold">Connected.</strong> Analytics will
            start flowing on the next scheduled sync.
          </div>
        )}
        {groups.map((g) => {
          const groupIntegrations = integrations.filter((i) => i.tag === g);
          if (groupIntegrations.length === 0) return null;
          return (
            <div key={g} className="mb-7">
              <h2 className="text-[13px] font-mono uppercase tracking-[0.08em] text-ink-3 mb-3">{g}</h2>
              <div className="grid grid-cols-4 gap-3">
                {groupIntegrations.map((i) => (
                  <div key={i.id} className="border border-line rounded-[10px] p-4 bg-bg">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-[7px] bg-ink text-bg grid place-items-center font-mono text-[11px] font-semibold">
                        {i.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1">
                        <div className="font-semibold text-sm">{i.name}</div>
                        <div className="font-mono text-[11px] text-ink-3">{i.tag}</div>
                      </div>
                      <StatusPill
                        status={connectedIds.has(i.id) ? "on" : "setup"}
                        label={connectedIds.has(i.id) ? "Connected" : "Not connected"}
                      />
                    </div>
                    <p className="text-[12.5px] text-ink-2 my-2.5 leading-[1.5]">{i.description}</p>
                    {GOOGLE_INTEGRATIONS.has(i.id) ? (
                      <GoogleConnectButton
                        integrationId={i.id as "gsc" | "ga4"}
                        connected={connectedIds.has(i.id)}
                      />
                    ) : (
                      <Button size="sm" disabled className="w-full justify-center">
                        Connect
                      </Button>
                    )}
                  </div>
                ))}
                {g === "CMS" && (
                  <div className="border border-line rounded-[10px] p-4 bg-bg flex flex-col">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-[7px] bg-accent text-white grid place-items-center">
                        <Icons.calendar size={15} />
                      </div>
                      <div className="flex-1">
                        <div className="font-semibold text-sm">Auto-publish</div>
                        <div className="font-mono text-[11px] text-ink-3">Schedule</div>
                      </div>
                      <StatusPill
                        status={enabledCadences.length > 0 ? "on" : "setup"}
                        label={enabledCadences.length > 0 ? `${enabledCadences.length} active` : "Not configured"}
                      />
                    </div>
                    <p className="text-[12.5px] text-ink-2 my-2.5 leading-[1.5] flex-1">
                      {enabledCadences.length > 0
                        ? enabledCadences.map((c) => {
                            const days = c.days_of_week.map((d) => DAY_SHORT[d]).join(", ");
                            return `${days} at ${c.publish_time.slice(0, 5)}`;
                          }).join(" · ")
                        : "Set a recurring publishing cadence per workspace"}
                    </p>
                    {workspaces.length > 0 ? (
                      <Link href={workspaces.length === 1 ? `/workspaces/${workspaces[0].id}` : "/workspaces"}>
                        <Button size="sm" variant="ghost" className="w-full justify-center">
                          Configure
                        </Button>
                      </Link>
                    ) : (
                      <Button size="sm" disabled className="w-full justify-center">
                        Configure
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
