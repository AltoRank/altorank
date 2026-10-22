import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared by /signin's form and the signup form's "already have an account":
// send the code, give a user Supabase just made its account (#336), and only
// then remember the address for /signin/code.

const mocks = vi.hoisted(() => ({
  sendSignInCode: vi.fn(),
  startSigninCodeSignup: vi.fn(async (..._a: unknown[]) => "acc-1"),
  set: vi.fn(),
}));
vi.mock("@/lib/email/auth-emails", () => ({ sendSignInCode: mocks.sendSignInCode }));
vi.mock("@/lib/auth/signin-code-signup", () => ({ startSigninCodeSignup: mocks.startSigninCodeSignup }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.set }) }));

import { emailSignInCode } from "../code-signin";
import { PENDING_SIGNIN_COOKIE } from "../pending-signin";

beforeEach(() => vi.clearAllMocks());

describe("emailSignInCode", () => {
  it("sends the code and remembers the address for /signin/code, in a cookie scoped to /signin", async () => {
    mocks.sendSignInCode.mockResolvedValue({ sent: true, createdUserId: null });
    await emailSignInCode("owner@example.com", "/dashboard");
    expect(mocks.sendSignInCode).toHaveBeenCalledWith("owner@example.com", "/dashboard");
    expect(mocks.startSigninCodeSignup).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith(PENDING_SIGNIN_COOKIE, "owner@example.com", expect.objectContaining({ httpOnly: true, path: "/signin" }));
  });

  it("makes the account for a user Supabase created to send the code to, with where they came from", async () => {
    mocks.sendSignInCode.mockResolvedValue({ sent: true, createdUserId: "u-new" });
    await emailSignInCode("new@example.com", "/dashboard");
    expect(mocks.startSigninCodeSignup).toHaveBeenCalledWith("u-new", "new@example.com", {});
    await emailSignInCode("new@example.com", "/dashboard", { lp: "/blog/x/", ref: "www.google.com" });
    expect(mocks.startSigninCodeSignup).toHaveBeenLastCalledWith("u-new", "new@example.com", { lp: "/blog/x/", ref: "www.google.com" });
  });

  it("throws, and remembers nothing, when the code did not go out", async () => {
    mocks.sendSignInCode.mockRejectedValue(new Error("provider down"));
    await expect(emailSignInCode("owner@example.com", "/dashboard")).rejects.toThrow("provider down");
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
