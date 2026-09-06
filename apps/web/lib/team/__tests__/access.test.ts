import { describe, it, expect } from "vitest";
import { parseWorkspaceIds, accessLabel, canEditMember, canManageMembers, canManageBilling, INVITABLE_ROLES } from "../access";

describe("workspace access", () => {
  const allowed = ["a", "b", "c"];
  it("empty means all sites, stored as null", () => {
    expect(parseWorkspaceIds([], allowed)).toBeNull();
  });
  it("keeps only the agency's own ids, once each", () => {
    expect(parseWorkspaceIds(["b", "zzz", "b", 3, null], allowed)).toEqual(["b"]);
  });
  it("a selection made only of foreign ids collapses to all sites rather than none", () => {
    // Nothing valid was chosen; the form never offers "no sites", so the
    // stored meaning is the default.
    expect(parseWorkspaceIds(["not-ours"], allowed)).toBeNull();
  });
  it("labels null as All sites and lists names otherwise", () => {
    const names = new Map([["a", "Acme"], ["b", "Bolt"]]);
    expect(accessLabel(null, names)).toBe("All sites");
    expect(accessLabel(["a", "b"], names)).toBe("Acme, Bolt");
    expect(accessLabel(["gone"], names)).toBe("No sites");
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
