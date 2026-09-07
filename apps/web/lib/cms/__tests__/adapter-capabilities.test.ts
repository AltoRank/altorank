import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UPDATABLE_CMS_TYPES } from "../adapter";
import { UPDATABLE_CMS } from "@/lib/refresh/push";

/**
 * What a CMS connection can do must be asked of the adapter, never restated.
 *
 * lib/refresh/push.ts carried the updatable set as a literal of five -
 * wordpress, ghost, webflow, webhook, git - and eleven adapters implemented
 * `update`. Both refresh screens read that literal to decide whether to offer
 * "Push to site", so a Shopify, HubSpot, Magento, Framer, WordPress-plugin
 * or WooCommerce customer was told their connection "can publish new posts but cannot yet
 * edit an existing one" and sent away to copy HTML by hand. `pushExecution`
 * asks `canUpdate(adapter)`, which would have said yes. The refresh loop -
 * the whole second half of the product - was off for six of thirteen CMSs
 * because a Set had not been updated.
 *
 * These tests are the reason it cannot happen again: the set is derived, and
 * the map it is derived from is checked against the resolver's own switch.
 */
describe("adapter capabilities", () => {
  it("maps exactly the types the resolver can build", () => {
    // The switch is the definition of "a CMS this product supports". A type
    // added there and forgotten in ADAPTER_CLASSES would be invisible to
    // every capability question asked about it, and would answer "cannot
    // update" for an adapter that can - which is the bug above, one CMS at a
    // time. ADAPTER_CLASSES is module-private, so this reads the source; the
    // route/queue pair in lib/content/generate-queue.ts pins a constant the
    // same way and for the same reason.
    const source = readFileSync(join(__dirname, "..", "adapter.ts"), "utf8");

    const mapBody = source.slice(
      source.indexOf("const ADAPTER_CLASSES"),
      source.indexOf("export const UPDATABLE_CMS_TYPES"),
    );
    const mapped = [...mapBody.matchAll(/^ {2}"?([a-z-]+)"?:/gm)].map((m) => m[1]).sort();

    const switchBody = source.slice(source.indexOf("export function resolveCMSAdapter"));
    const cases = [...switchBody.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]).sort();

    expect(cases.length).toBeGreaterThanOrEqual(13);
    expect(mapped).toEqual(cases);
  });

  it("includes every adapter that can edit a post in place", () => {
    // The six the stale literal dropped. Each has a real `update` - a PUT or
    // PATCH to the post the article already occupies (WooCommerce inherits
    // WordPress's) - so each can take a reviewed refresh without publishing a
    // second copy of the page.
    for (const type of ["shopify", "hubspot", "magento", "framer", "wordpress-plugin", "woocommerce"]) {
      expect(UPDATABLE_CMS_TYPES.has(type), `${type} can update in place`).toBe(true);
    }
    // And the five the literal did have.
    for (const type of ["wordpress", "ghost", "webflow", "webhook", "git"]) {
      expect(UPDATABLE_CMS_TYPES.has(type)).toBe(true);
    }
  });

  it("excludes the adapters that genuinely cannot", () => {
    // Notion and Wix, and only those two - which is exactly what
    // publishArticleCore says when it refuses a republish ("only Notion and
    // Wix reach this branch"). The refresh screens must keep refusing them,
    // because a second copy of the page is worse than no push.
    for (const type of ["notion", "wix"]) {
      expect(UPDATABLE_CMS_TYPES.has(type), `${type} cannot update in place`).toBe(false);
    }
  });

  it("is the same set the refresh UI reads", () => {
    expect([...UPDATABLE_CMS].sort()).toEqual([...UPDATABLE_CMS_TYPES].sort());
  });
});
