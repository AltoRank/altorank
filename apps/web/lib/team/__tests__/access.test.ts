import { describe, it, expect } from "vitest";
import { parseWorkspaceIds, accessLabel, canEditMember, canManageMembers, canManageBilling, canAddWorkspace, INVITABLE_ROLES } from "../access";

describe("workspace access", () => {
  const allowed = ["a", "b", "c"];
  it("empty means all sites, stored as null", () => {
    expect(parseWorkspaceIds([], allowed)).toBeNull();
  });
  it("keeps only the account's own ids, once each", () => {
    expect(parseWorkspaceIds(["b", "zzz", "b", 3, null], allowed)).toEqual(["b"]);
  });
  it("a selection made only of foreign ids collapses to all sites rather than none", () => {
    // Nothing valid was chosen; the form never offers "no sites", so the
    // stored meaning is the default.
    expect(parseWorkspaceIds(["not-ours"], allowed)).toBeNull();
  });
  it("labels null as All workspaces and lists names otherwise", () => {
    const names = new Map([["a", "Acme"], ["b", "Bolt"]]);
    expect(accessLabel(null, names)).toBe("All workspaces");
    expect(accessLabel(["a", "b"], names)).toBe("Acme, Bolt");
    expect(accessLabel(["gone"], names)).toBe("No workspaces");
  });
});

describe("roles", () => {
  it("invites grant editor or admin, never owner", () => {
    expect([...INVITABLE_ROLES]).toEqual(["editor", "admin"]);
  });
  it("editors cannot manage members or billing; admins manage members; owners manage both", () => {
    expect(canManageMembers("editor")).toBe(false);
    expect(canManageMembers("admin")).toBe(true);
    expect(canManageBilling("admin")).toBe(false);
    expect(canManageBilling("owner")).toBe(true);
    expect(canManageMembers(null)).toBe(false);
  });
  it("nobody edits themselves, and only owners touch owners", () => {
    const owner = { userId: "o", role: "owner" };
    const admin = { userId: "a", role: "admin" };
    const editor = { userId: "e", role: "editor" };
    expect(canEditMember(admin, editor)).toBe(true);
    expect(canEditMember(admin, admin)).toBe(false);
    expect(canEditMember(admin, owner)).toBe(false);
    expect(canEditMember(owner, admin)).toBe(true);
    expect(canEditMember(editor, editor)).toBe(false);
    expect(canEditMember(editor, { userId: "x", role: "editor" })).toBe(false);
  });
});

describe("canAddWorkspace", () => {
  // Adding a site takes a plan slot and starts drawing on the account's
  // monthly article allowance, so it belongs with the other actions an editor
  // is told they cannot take. `createWorkspace` had no role check at all: a
  // member scoped to one site could add a fourth to somebody else's account,
  // then read "Upgrade on the Billing page" - a page they can only look at.
  it("is owner and admin, matching the Search Console door that also creates sites", () => {
    expect(canAddWorkspace("owner")).toBe(true);
    expect(canAddWorkspace("admin")).toBe(true);
    expect(canAddWorkspace("editor")).toBe(false);
    expect(canAddWorkspace(null)).toBe(false);
    expect(canAddWorkspace(undefined)).toBe(false);
  });

  it("is not the billing rule: an admin adds sites but does not pay", () => {
    expect(canAddWorkspace("admin")).toBe(true);
    expect(canManageBilling("admin")).toBe(false);
  });
});

describe("a member limited to some sites", () => {
  const account = ["a", "b", "c"];

  it("knows who is limited and whose access reaches further", async () => {
    const { isSiteLimited, withinScope } = await import("../access");
    expect(isSiteLimited(null)).toBe(false);
    expect(isSiteLimited(["a"])).toBe(true);
    expect(withinScope(null, null)).toBe(true);
    expect(withinScope(["a", "b"], ["a"])).toBe(true);
    expect(withinScope(["a"], ["a", "b"])).toBe(false);
    expect(withinScope(["a"], null)).toBe(false);
  });

  describe("invites", () => {
    it("an actor with every site keeps the old meaning of empty", async () => {
      const { decideInviteSites } = await import("../access");
      expect(decideInviteSites({ actorSites: null, picked: [], accountSites: account })).toEqual({ ok: true, workspaceIds: null });
    });
    it("a limited actor must pick, and only from their own sites", async () => {
      const { decideInviteSites } = await import("../access");
      expect(decideInviteSites({ actorSites: ["a"], picked: [], accountSites: account }).ok).toBe(false);
      expect(decideInviteSites({ actorSites: ["a"], picked: ["b"], accountSites: account }).ok).toBe(false);
      expect(decideInviteSites({ actorSites: ["a"], picked: ["a", "b"], accountSites: account })).toEqual({ ok: true, workspaceIds: ["a"] });
    });
  });

  describe("editing a member", () => {
    it("an actor with every site is unchanged", async () => {
      const { decideMemberSites } = await import("../access");
      expect(decideMemberSites({ actorSites: null, targetSites: ["a"], picked: [], accountSites: account })).toEqual({ ok: true, workspaceIds: null });
      expect(decideMemberSites({ actorSites: null, targetSites: null, picked: ["b"], accountSites: account })).toEqual({ ok: true, workspaceIds: ["b"] });
    });
    it("never produces every site or an empty list", async () => {
      const { decideMemberSites } = await import("../access");
      expect(decideMemberSites({ actorSites: ["a"], targetSites: ["a"], picked: [], accountSites: account }).ok).toBe(false);
      expect(decideMemberSites({ actorSites: ["a"], targetSites: ["a"], picked: ["zzz"], accountSites: account }).ok).toBe(false);
    });
    it("adds only the actor's own sites and keeps the target's others", async () => {
      const { decideMemberSites } = await import("../access");
      const out = decideMemberSites({ actorSites: ["a", "b"], targetSites: ["b", "c"], picked: ["a", "c"], accountSites: account });
      expect(out.ok).toBe(true);
      if (out.ok) expect([...(out.workspaceIds ?? [])].sort()).toEqual(["a", "c"]);
    });
    it("leaves a target with every site as it is, and refuses to narrow it", async () => {
      const { decideMemberSites } = await import("../access");
      expect(decideMemberSites({ actorSites: ["a"], targetSites: null, picked: [], accountSites: account })).toEqual({ ok: true, workspaceIds: null });
      expect(decideMemberSites({ actorSites: ["a"], targetSites: null, picked: ["a"], accountSites: account }).ok).toBe(false);
    });
  });
});
