import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The picker's label for a site that is already a workspace. A Search Console
// row Google refused the token for (migration 070) reads nothing, so calling
// it "connected" told someone their site was fine when the nightly sync had
// stopped.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/actions/google-properties", () => ({
  connectPropertyToWorkspace: vi.fn(),
  createWorkspacesFromProperties: vi.fn(),
}));

import { PropertyPicker } from "../property-picker";
import type { DetectedProperty } from "@/app/actions/google-properties";

const WS = "11111111-1111-4111-8111-111111111111";

function property(over: Partial<DetectedProperty> = {}): DetectedProperty {
  return {
    siteUrl: "sc-domain:acme.co",
    domain: "acme.co",
    permissionLevel: "siteOwner",
    canRead: true,
    isOwner: true,
    existingWorkspaceId: WS,
    existingConnected: false,
    existingNeedsReconnect: false,
    ...over,
  };
}

/** The status cell's text: the link to the workspace and its button, if any. */
function status(p: DetectedProperty): string {
  const html = renderToStaticMarkup(<PropertyPicker properties={[p]} />);
  const link = html.match(new RegExp(`<a[^>]*href="/workspaces/${WS}"[^>]*>([^<]*)</a>`));
  const button = html.match(/<button[^>]*>(Connect|Reconnect)<\/button>/);
  return [link?.[1], button?.[1]].filter(Boolean).join(" + ");
}

describe("PropertyPicker, a site that is already a workspace", () => {
  it("says connected for a live Search Console connection, with nothing to press", () => {
    expect(status(property({ existingConnected: true }))).toBe("connected");
  });

  it("says needs reconnect, with a Reconnect, when Google refused the token", () => {
    expect(status(property({ existingNeedsReconnect: true }))).toBe("needs reconnect + Reconnect");
  });

  it("says already a workspace, with a Connect, when Search Console was never connected", () => {
    expect(status(property())).toBe("already a workspace + Connect");
  });

  it("offers no Reconnect for a property this Google account cannot read", () => {
    expect(
      status(property({ existingNeedsReconnect: true, canRead: false, permissionLevel: "siteRestrictedUser", isOwner: false })),
    ).toBe("needs reconnect");
  });
});
