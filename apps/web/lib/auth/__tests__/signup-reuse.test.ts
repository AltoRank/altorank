import { describe, expect, it } from "vitest";
import { existingSignup } from "../signup-reuse";
import { fakeDb } from "@/lib/onboarding/__tests__/fake-runs-client";

describe("existingSignup", () => {
  it("finds nothing for a first submit", async () => {
    const db = fakeDb({ account_members: [], workspaces: [] });
    expect(await existingSignup(db.client, "u1", "acme.com")).toEqual({ accountId: null, workspaceId: null });
  });

  it("finds the account and the site a first submit already made, so a second makes neither again", async () => {
    // novatristech.com, 2026-09-22: the same user, eight seconds later.
    const db = fakeDb({
      account_members: [{ account_id: "acc-1", user_id: "u1", role: "owner" }],
      workspaces: [{ id: "ws-1", account_id: "acc-1", domain: "novatristech.com" }],
    });
    expect(await existingSignup(db.client, "u1", "novatristech.com")).toEqual({ accountId: "acc-1", workspaceId: "ws-1" });
  });

  it("finds the account but no site when the first submit stopped before the workspace", async () => {
    const db = fakeDb({ account_members: [{ account_id: "acc-1", user_id: "u1", role: "owner" }], workspaces: [] });
    expect(await existingSignup(db.client, "u1", "acme.com")).toEqual({ accountId: "acc-1", workspaceId: null });
  });

  it("does not match a site on another account", async () => {
    const db = fakeDb({
      account_members: [{ account_id: "acc-1", user_id: "u1", role: "owner" }],
      workspaces: [{ id: "ws-9", account_id: "acc-9", domain: "acme.com" }],
    });
    expect((await existingSignup(db.client, "u1", "acme.com")).workspaceId).toBeNull();
  });
});
