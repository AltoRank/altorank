// The signup a free tool links to asks for an email and a password and makes
// nothing but the auth user: no account row, no membership, no workspace.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendSignupConfirmation, redirect, createServiceClient } = vi.hoisted(() => ({
  sendSignupConfirmation: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  }),
  createServiceClient: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/email/auth-emails", () => ({ sendSignupConfirmation }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient, createClient: createServiceClient }));

import { signUpForTools, TOOLS_SIGNUP_SENT } from "../tools-signup";

const RETURN = "https://altorank.co/tools/grammar-checker/";

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function landing(p: Promise<unknown>): Promise<URL> {
  try {
    await p;
  } catch (e) {
    return new URL((e as { to: string }).to, "https://app.altorank.co");
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  sendSignupConfirmation.mockReset();
  redirect.mockClear();
  createServiceClient.mockReset();
});

describe("signUpForTools", () => {
  it("creates the user with the tools email, back through /tool-return, and nothing else", async () => {
    sendSignupConfirmation.mockResolvedValue("u1");
    const to = await landing(signUpForTools(form({ email: " a@x.co ", password: "longenough" }), "grammar-checker", RETURN));
    expect(sendSignupConfirmation).toHaveBeenCalledWith({
      email: "a@x.co",
      password: "longenough",
      next: "/tool-return/grammar-checker",
      variant: "tools",
    });
    // No account, membership or workspace: the service client is never built.
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(to.pathname).toBe("/signup");
    expect(to.searchParams.get("from")).toBe("tools");
    expect(to.searchParams.get("return_to")).toBe(RETURN);
    expect(to.searchParams.get("success")).toBe(TOOLS_SIGNUP_SENT);
  });

  it("keeps the tools variant on an error", async () => {
    sendSignupConfirmation.mockRejectedValue(new Error("User already registered"));
    const to = await landing(signUpForTools(form({ email: "a@x.co", password: "longenough" }), "grammar-checker", RETURN));
    expect(to.searchParams.get("error")).toBe("User already registered");
    expect(to.searchParams.get("from")).toBe("tools");
    expect(to.searchParams.get("return_to")).toBe(RETURN);
  });

  it("refuses an empty form without creating anything", async () => {
    const to = await landing(signUpForTools(form({ email: "", password: "" }), "grammar-checker", RETURN));
    expect(to.searchParams.get("error")).toMatch(/email/);
    expect(sendSignupConfirmation).not.toHaveBeenCalled();
  });
});
