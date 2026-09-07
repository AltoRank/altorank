import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTABLE_CMS, isRequestable } from "../connectable";
import { resolveCMSAdapter } from "../adapter";

/**
 * Two lists decide what a person can reach. CONNECTABLE_CMS draws Connect or
 * "Request integration" on the tile; CMS_TYPES in connect-cms-dialog.tsx
 * decides whether the dialog opens at all. The invariant is a subset, not
 * equality: the dialog may open for more than the tiles advertise (an existing
 * connection's Reconnect, a hand-held onboarding link), but a tile must never
 * offer Connect for something the dialog will refuse to open.
 */
function dialogCmsTypes(): string[] {
  const src = readFileSync(
    join(__dirname, "../../../components/dashboard/connect-cms-dialog.tsx"),
    "utf8",
  );
  const block = src.match(/const CMS_TYPES: CMSType\[\] = \[([\s\S]*?)\];/);
  if (!block) throw new Error("CMS_TYPES not found in connect-cms-dialog.tsx");
  return [...block[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

describe("connectable", () => {
  it("never advertises Connect for a platform the dialog will not open", () => {
    const dialog = new Set(dialogCmsTypes());
    for (const id of CONNECTABLE_CMS) expect(dialog).toContain(id);
  });

  it("advertises nothing while no connector has been watched working live", () => {
    // Deliberate, and the one line to change when that stops being true.
    // See the note on CONNECTABLE_CMS.
    expect(CONNECTABLE_CMS.size).toBe(0);
  });

  it("keeps every adapter reachable, so existing connections still publish", () => {
    // Withdrawing the advertisement must not withdraw the capability: these
    // resolve for a connection made before this change, and for a reconnect.
    expect(() =>
      resolveCMSAdapter({ type: "framer", siteId: "s", collectionId: "c", apiToken: "t" }),
    ).not.toThrow();
    expect(dialogCmsTypes()).toContain("framer");
    expect(dialogCmsTypes()).toContain("wordpress");
  });

  it("offers a request for anything with no adapter and no OAuth flow of its own", () => {
    for (const id of ["ahrefs", "slack", "zapier", "framer"]) {
      expect(isRequestable(id, false)).toBe(true);
    }
  });

  it("offers a request for every CMS while the connectable set is empty", () => {
    for (const id of dialogCmsTypes()) expect(isRequestable(id, false)).toBe(true);
  });

  it("never offers a request for something connectable, or with its own flow", () => {
    for (const id of CONNECTABLE_CMS) expect(isRequestable(id, false)).toBe(false);
    // Google and Bing render their own buttons; the page passes hasOwnFlow.
    for (const id of ["gsc", "ga4", "bing"]) expect(isRequestable(id, true)).toBe(false);
  });

  it("defaults an unknown integration to a request rather than a dead button", () => {
    expect(isRequestable("some-cms-added-to-the-db-tomorrow", false)).toBe(true);
  });
});
