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
  const { workspaces, active } = useWorkspace();

  // Binds to whatever the sidebar switcher is scoped to, like every other
  // page. It used to carry its own workspace <select>, from when the switcher
  // changed nothing else; now that the switcher scopes the whole app, a second
  // picker here offered a site the rest of the screen was not showing.
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
