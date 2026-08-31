"use client";

import { Button } from "@/components/ui";
import { useWorkspace } from "@/components/dashboard/workspace-context";

/**
 * Connect button for the Google-backed integrations (Search Console, GA4).
 *
 * Scoped to the active workspace, because tokens are stored per workspace in
 * `workspace_integrations`: an agency connects each client's Search Console
 * separately, so "connect" is meaningless without knowing which client.
 *
 * A plain link rather than a fetch: the endpoint issues a 302 to Google's
 * consent screen, and a full navigation is what OAuth needs. Going through
 * fetch would follow the redirect and hand back Google's HTML.
 */
export function GoogleConnectButton({
  integrationId,
  connected,
}: {
  integrationId: "gsc" | "ga4";
  connected?: boolean;
}) {
  const { workspaces, active, setActiveId } = useWorkspace();

  // This was the only consumer of the sidebar's workspace switcher: switching
  // changed nothing on any page except which workspace this button would bind
  // a Google account to, invisibly. The choice belongs here, next to its one
  // effect, where it is visible at the moment it matters.
  const target = active ?? workspaces[0];

  if (!target) {
    return (
      <Button size="sm" disabled className="w-full justify-center">
        Add a workspace first
      </Button>
    );
  }

  const href = `/api/auth/google?workspaceId=${target.id}&integrationId=${integrationId}`;

  return (
    <div className="flex flex-col gap-1.5">
      {workspaces.length > 1 && (
        <select
          value={target.id}
          onChange={(e) => setActiveId(e.target.value)}
          aria-label="Workspace to connect"
          className="w-full rounded-[6px] border border-line bg-panel px-2 py-1.5 text-[12px] text-ink-2"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      )}
      <a href={href} className="block">
        <Button
          size="sm"
          variant={connected ? "ghost" : "accent"}
          className="w-full justify-center"
        >
          {connected ? `Reconnect for ${target.name}` : `Connect for ${target.name}`}
        </Button>
      </a>
    </div>
  );
}
