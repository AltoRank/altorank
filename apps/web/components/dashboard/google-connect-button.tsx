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
  const { active } = useWorkspace();

  if (!active) {
    return (
      <Button size="sm" disabled className="w-full justify-center">
        Select a client first
      </Button>
    );
  }

  const href = `/api/auth/google?workspaceId=${active.id}&integrationId=${integrationId}`;

  return (
    <a href={href} className="block">
      <Button
        size="sm"
        variant={connected ? "ghost" : "accent"}
        className="w-full justify-center"
      >
        {connected ? `Reconnect for ${active.name}` : `Connect for ${active.name}`}
      </Button>
    </a>
  );
}
