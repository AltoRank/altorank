import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

// ---------------------------------------------------------------------------
// resolveGscSiteUrl: a stored property is read only while it is the site's
// ---------------------------------------------------------------------------

const listGSCSites = vi.fn();
vi.mock("@/lib/google/gsc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/gsc")>();
  return { ...real, listGSCSites: (...args: unknown[]) => listGSCSites(...args) };
});

const { resolveGscSiteUrl } = await import("../sync");

function db() {
  return fakeSupabase({
    workspace_integrations: [{ id: "wi-1", workspace_id: "ws-1", integration_id: "gsc", config: {} }],
  });
}

beforeEach(() => {
  listGSCSites.mockReset();
  listGSCSites.mockResolvedValue([
    { siteUrl: "sc-domain:acme.co", permissionLevel: "siteOwner" },
    { siteUrl: "sc-domain:client-b.example", permissionLevel: "siteOwner" },
  ]);
});

describe("resolveGscSiteUrl", () => {
  it("uses a stored property that belongs to the site without asking Google", async () => {
    const supabase = db();
    const url = await resolveGscSiteUrl(
      supabase as unknown as SupabaseClient,
      { id: "wi-1", config: { gscSiteUrl: "sc-domain:acme.co" } },
      "acme.co",
      "token",
    );
    expect(url).toBe("sc-domain:acme.co");
    expect(listGSCSites).not.toHaveBeenCalled();
  });

  it("ignores a stored property of another site and resolves the site's own", async () => {
    const supabase = db();
    const url = await resolveGscSiteUrl(
      supabase as unknown as SupabaseClient,
      { id: "wi-1", config: { gscSiteUrl: "sc-domain:client-b.example" } },
      "acme.co",
      "token",
    );
    expect(url).toBe("sc-domain:acme.co");
    expect(supabase.tables.workspace_integrations[0].config).toMatchObject({ gscSiteUrl: "sc-domain:acme.co" });
  });

  it("refuses when the token sees no property for the site", async () => {
    listGSCSites.mockResolvedValue([{ siteUrl: "sc-domain:client-b.example", permissionLevel: "siteOwner" }]);
    await expect(
      resolveGscSiteUrl(
        db() as unknown as SupabaseClient,
        { id: "wi-1", config: { gscSiteUrl: "sc-domain:client-b.example" } },
        "acme.co",
        "token",
      ),
    ).rejects.toThrow(/no Search Console property for acme\.co/);
  });
});
