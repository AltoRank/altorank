import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTABLE_CMS, isRequestable } from "../connectable";
import { resolveCMSAdapter } from "../adapter";

/**
 * Two lists decide whether a person is offered a credential form: this one,
 * which draws Connect or "Request integration" on the tile, and CMS_TYPES in
 * connect-cms-dialog.tsx, which decides whether the dialog opens at all. They
 * were one list until the tile gained a second state; if they drift, a tile
 * says Connect and the dialog refuses to open, or worse, the reverse.
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
  it("agrees with the dialog about which platforms can be connected", () => {
    expect(new Set(dialogCmsTypes())).toEqual(CONNECTABLE_CMS);
  });

  it("does not offer Framer, whose adapter was never exercised", () => {
    expect(CONNECTABLE_CMS.has("framer")).toBe(false);
    expect(dialogCmsTypes()).not.toContain("framer");
    // The adapter stays registered: connections made before this must keep
    // publishing, and only the ability to create a new one is withdrawn.
    expect(() =>
      resolveCMSAdapter({ type: "framer", siteId: "s", collectionId: "c", apiToken: "t" }),
    ).not.toThrow();
  });

  it("offers a request for anything with no adapter and no OAuth flow of its own", () => {
    for (const id of ["ahrefs", "slack", "zapier", "framer"]) {
      expect(isRequestable(id, false)).toBe(true);
    }
  });

  it("never offers a request for something already connectable, or with its own flow", () => {
    for (const id of CONNECTABLE_CMS) expect(isRequestable(id, false)).toBe(false);
    // Google and Bing render their own buttons; the page passes hasOwnFlow.
    for (const id of ["gsc", "ga4", "bing"]) expect(isRequestable(id, true)).toBe(false);
  });

  it("defaults an unknown integration to a request rather than a dead button", () => {
    expect(isRequestable("some-cms-added-to-the-db-tomorrow", false)).toBe(true);
  });
});
