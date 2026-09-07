import { describe, it, expect } from "vitest";
import { DASHBOARD_NAV } from "@/lib/constants";

/**
 * The sidebar stopped drawing its group captions on 2026-09-07 and now
 * separates groups with a hairline instead. `NavGroup.group` survived that as
 * the group's key AND as its `aria-label` in components/dashboard/sidebar.tsx,
 * which is a fragile place to be: a string with no visible output reads like
 * dead data, and the obvious "cleanup" is to empty it or drop it. Then the
 * only label a screen reader had is gone and nothing looks different.
 *
 * So: the invariant that the visible design no longer enforces is enforced
 * here.
 */
describe("DASHBOARD_NAV group names", () => {
  it("gives every group a non-empty name to be announced by", () => {
    expect(DASHBOARD_NAV.length).toBeGreaterThan(0);
    for (const group of DASHBOARD_NAV) {
      expect(group.group.trim()).not.toBe("");
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("keeps those names distinct, since they are also the render key", () => {
    const names = DASHBOARD_NAV.map((g) => g.group);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps every nav id unique across groups and children", () => {
    const ids: string[] = [];
    for (const group of DASHBOARD_NAV) {
      for (const item of group.items) {
        ids.push(item.id);
        for (const child of item.children ?? []) ids.push(child.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
