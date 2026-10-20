// A sign-in code asked for an address with no user is a signup: Supabase makes
// the user. It gets its account and its `signup` event here, the way the signup
// form makes them, so it is counted with a source and not left to the
// membership fallback (2026-10-19: a real signup came in that way, uncounted,
// with no site).

import { beforeEach, describe, expect, it, vi } from "vitest";

let membership: { account_id: string } | null = null;
let membershipError: { message: string } | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: membership, error: membershipError }),
      };
      return chain;
    },
  }),
}));

const { createOwnedAccount, recordEvent } = vi.hoisted(() => ({
  createOwnedAccount: vi.fn(async () => "acct-new"),
  recordEvent: vi.fn(async () => true),
}));
vi.mock("@/lib/queries/account", () => ({ createOwnedAccount }));
vi.mock("@/lib/observability/record", () => ({ recordEvent }));

import { startSigninCodeSignup } from "../signin-code-signup";

beforeEach(() => {
  membership = null;
  membershipError = null;
  createOwnedAccount.mockClear();
  createOwnedAccount.mockResolvedValue("acct-new");
  recordEvent.mockClear();
});

describe("startSigninCodeSignup", () => {
  it("makes the account and records a signup with the sign-in code as its source", async () => {
    await expect(startSigninCodeSignup("u1", "jane.doe@x.example")).resolves.toBe("acct-new");
    expect(createOwnedAccount).toHaveBeenCalledWith("u1", {}, "jane.doe@x.example");
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        source: "signup",
        accountId: "acct-new",
        context: { stage: "created", userId: "u1", source: "signin_code" },
      }),
    );
    // The user id is the join; the address stays out of the event.
    expect(JSON.stringify(recordEvent.mock.calls)).not.toContain("jane.doe");
  });

  it("makes nothing twice when the user already has an account", async () => {
    membership = { account_id: "acct-1" };
    await expect(startSigninCodeSignup("u1", "a@x.example")).resolves.toBe("acct-1");
    expect(createOwnedAccount).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("records the failure and does not throw: the code is already on its way", async () => {
    createOwnedAccount.mockRejectedValue(new Error("insert refused"));
    await expect(startSigninCodeSignup("u1", "a@x.example")).resolves.toBeNull();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", source: "signup", context: { stage: "account", userId: "u1", source: "signin_code" } }),
    );
  });

  it("does not create an account when it cannot tell whether one exists", async () => {
    membershipError = { message: "timeout" };
    await expect(startSigninCodeSignup("u1", "a@x.example")).resolves.toBeNull();
    expect(createOwnedAccount).not.toHaveBeenCalled();
  });
});
