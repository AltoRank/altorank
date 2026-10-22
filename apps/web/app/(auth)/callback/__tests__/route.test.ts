import { beforeEach, describe, expect, it, vi } from "vitest";

// /callback, the one-click link in our own emails: where it goes after the
// token is verified, and where an expired one sends the person.

const mocks = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  sendWelcome: vi.fn(async (..._a: unknown[]) => undefined),
  recordSignIn: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: mocks.verifyOtp, exchangeCodeForSession: mocks.exchangeCodeForSession } }),
}));
vi.mock("@/lib/auth/welcome", () => ({ sendWelcome: mocks.sendWelcome }));
vi.mock("@/lib/auth/signin-event", () => ({ recordSignIn: mocks.recordSignIn }));

import { GET } from "../route";

const ORIGIN = "https://app.example";
const open = async (query: Record<string, string>) => {
  const res = await GET(new Request(`${ORIGIN}/callback?${new URLSearchParams(query)}`));
  return res.headers.get("location") ?? "";
};

beforeEach(() => {
  mocks.verifyOtp.mockReset();
  mocks.recordSignIn.mockClear();
  mocks.sendWelcome.mockClear();
});

describe("GET /callback", () => {
  it("keeps a next with a query: the sign-in code email's link lands on the page the email was about", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
    expect(await open({ token_hash: "h", type: "magiclink", next: "/articles?status=review" })).toBe(`${ORIGIN}/articles?status=review`);
    expect(mocks.recordSignIn).toHaveBeenCalledWith("link", "u1");
  });

  it("refuses a next that leaves the site, for the dashboard", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    expect(await open({ token_hash: "h", type: "magiclink", next: "//evil.example/x" })).toBe(`${ORIGIN}/dashboard`);
    expect(await open({ token_hash: "h", type: "magiclink", next: "https://evil.example" })).toBe(`${ORIGIN}/dashboard`);
  });

  it("still opens a password reset on its own page", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
    expect(await open({ token_hash: "h", type: "recovery", next: "/reset-password/confirm" })).toBe(`${ORIGIN}/reset-password/confirm`);
    expect(mocks.recordSignIn).not.toHaveBeenCalled();
  });

  it("sends an expired link to the code form, still holding where it was going", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({ data: { user: null }, error: { message: "Token has expired or is invalid" } });
    const location = new URL(await open({ token_hash: "h", type: "magiclink", next: "/articles?status=review" }));
    expect(location.pathname).toBe("/signin");
    expect(location.searchParams.get("error")).toBe("That link has expired. We can email you a new code.");
    expect(location.searchParams.get("next")).toBe("/articles?status=review");
    expect(mocks.recordSignIn).not.toHaveBeenCalled();
  });
});
