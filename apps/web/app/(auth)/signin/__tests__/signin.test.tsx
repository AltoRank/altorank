import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /signin, where every signed-out app link lands (most of them from an
 * email). Code signup gives an account a random password nobody is shown,
 * so the page asks for a code first and keeps the password one tap away:
 *
 *   /signin?next=…                 -> one email field, "Email me a sign-in code"
 *   /signin?method=password&next=… -> the password form, for whoever has one
 *   request a code                 -> /signin/code?step=code, next kept
 *   a wrong password               -> back on the password form, next kept
 */

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  sendSignInCode: vi.fn(async (..._a: unknown[]): Promise<{ sent: boolean; createdUserId: string | null }> => ({ sent: true, createdUserId: null })),
  startSigninCodeSignup: vi.fn(async (..._a: unknown[]) => "acc-new"),
  signInWithPassword: vi.fn(),
  verifyOtp: vi.fn(),
  recordSignIn: vi.fn(async (..._a: unknown[]) => undefined),
  jar: new Map<string, string>(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "app.altorank.co" }),
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { value: mocks.jar.get(name) } : undefined),
    set: (name: string, value: string) => void mocks.jar.set(name, value),
    delete: ({ name }: { name: string }) => void mocks.jar.delete(name),
  }),
}));
vi.mock("@/lib/email/auth-emails", () => ({ sendSignInCode: mocks.sendSignInCode }));
vi.mock("@/lib/auth/signin-event", () => ({ recordSignIn: mocks.recordSignIn }));
vi.mock("@/lib/auth/signin-code-signup", () => ({ startSigninCodeSignup: mocks.startSigninCodeSignup }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithPassword: mocks.signInWithPassword, verifyOtp: mocks.verifyOtp } }),
}));

import SignInPage from "../page";
import SignInCodePage from "../code/page";
import { requestSignInCode, signInWithPassword, verifySignInCode } from "../actions";
import { PENDING_SIGNIN_COOKIE } from "@/lib/auth/pending-signin";

const page = async (searchParams: Record<string, string>) => renderToStaticMarkup((await SignInPage({ searchParams: Promise.resolve(searchParams) })) as ReactElement);

async function redirectOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    const m = (e as Error).message.match(/^NEXT_REDIRECT (.*)$/);
    if (m) return m[1];
    throw e;
  }
  throw new Error("expected a redirect");
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  mocks.jar.clear();
  mocks.sendSignInCode.mockClear();
  mocks.startSigninCodeSignup.mockClear();
  mocks.recordSignIn.mockClear();
  mocks.signInWithPassword.mockReset();
  mocks.verifyOtp.mockReset();
});

describe("/signin", () => {
  it("asks for the address and a code first, with no password field", async () => {
    const html = await page({ next: "/articles?status=review" });
    expect(html).toContain(">Email me a sign-in code</button>");
    expect(html).not.toContain('type="password"');
    expect(html).toContain('name="next" value="/articles?status=review"');
    // One tap to the password, which also works without JavaScript.
    expect(html).toContain("Use a password instead");
    expect(html).toContain('href="/signin?method=password&amp;next=%2Farticles%3Fstatus%3Dreview"');
  });

  it("binds its label, says what the field holds, and is 16px on a phone", async () => {
    const html = await page({});
    expect(html).toMatch(/<label for="signin-email"[^>]*>Email<\/label>/);
    const input = html.match(/<input id="signin-email"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('type="email"');
    expect(input).toContain('name="email"');
    expect(input).toMatch(/autocomplete="email"/i);
    expect(input).toMatch(/class="[^"]*text-base sm:text-\[14px\]/);
  });

  it("opens on the password form at ?method=password, for whoever has one", async () => {
    const html = await page({ method: "password" });
    expect(html).toMatch(/<label for="signin-password"[^>]*>Password<\/label>/);
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain(">Sign in</button>");
    expect(html).toContain('href="/reset-password"');
    expect(html).toContain("Email me a code instead");
  });

  it("announces an error", async () => {
    const html = await page({ error: "That link has expired. We can email you a new code." });
    expect(html).toMatch(/<div role="alert"[^>]*>That link has expired\. We can email you a new code\.<\/div>/);
  });
});

describe("the sign-in actions", () => {
  it("sends the code, remembers the address for the code page and keeps next", async () => {
    const url = await redirectOf(requestSignInCode(form({ email: " Owner@Example.com ", next: "/articles?status=review" })));
    expect(mocks.sendSignInCode).toHaveBeenCalledWith("owner@example.com", "/articles?status=review");
    expect(mocks.jar.get(PENDING_SIGNIN_COOKIE)).toBe("owner@example.com");
    expect(url).toBe("/signin/code?step=code&next=%2Farticles%3Fstatus%3Dreview");
  });

  it("makes the account for an address Supabase just created to send the code (#336), and only then", async () => {
    await redirectOf(requestSignInCode(form({ email: "owner@example.com" })));
    expect(mocks.startSigninCodeSignup).not.toHaveBeenCalled();
    mocks.sendSignInCode.mockResolvedValueOnce({ sent: true, createdUserId: "u-new" });
    const url = await redirectOf(requestSignInCode(form({ email: "new@example.com", next: "/dashboard" })));
    expect(mocks.startSigninCodeSignup).toHaveBeenCalledWith("u-new", "new@example.com", {});
    // The same page either way: the form says nothing about which addresses exist.
    expect(url).toBe("/signin/code?step=code&next=%2Fdashboard");
  });

  it("keeps a code request's error on /signin, where the form is", async () => {
    expect(await redirectOf(requestSignInCode(form({ email: "nope", next: "/dashboard" })))).toBe("/signin?error=Enter+your+email+address.&next=%2Fdashboard");
    mocks.sendSignInCode.mockRejectedValueOnce(new Error("provider down"));
    expect(await redirectOf(requestSignInCode(form({ email: "owner@example.com" })))).toBe("/signin?error=The+code+could+not+be+sent.+Try+again+in+a+minute.");
  });

  it("signs in with the typed code, says how, and goes where the email was going", async () => {
    mocks.jar.set(PENDING_SIGNIN_COOKIE, "owner@example.com");
    mocks.verifyOtp.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
    expect(await redirectOf(verifySignInCode(form({ code: "123456", next: "/content/a1" })))).toBe("/content/a1");
    expect(mocks.recordSignIn).toHaveBeenCalledWith("code", "u1");
    expect(mocks.jar.has(PENDING_SIGNIN_COOKIE)).toBe(false);
  });

  it("sends a code page whose address is gone back to /signin to ask again", async () => {
    expect(await redirectOf(verifySignInCode(form({ code: "123456", next: "/dashboard" })))).toBe("/signin?error=That+code+page+expired.+Ask+for+a+new+code.&next=%2Fdashboard");
  });

  it("returns a wrong password to the password form with next, in words that point at the code", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: "Invalid login credentials" } });
    const url = await redirectOf(signInWithPassword(form({ email: "owner@example.com", password: "x", next: "/articles?status=review" })));
    const q = new URL(url, "http://x").searchParams;
    expect(url.startsWith("/signin?")).toBe(true);
    expect(q.get("method")).toBe("password");
    expect(q.get("next")).toBe("/articles?status=review");
    expect(q.get("error")).toContain("email yourself a sign-in code instead");
    expect(mocks.recordSignIn).not.toHaveBeenCalled();
  });

  it("signs in with a password and says how", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({ data: { user: { id: "u2" } }, error: null });
    expect(await redirectOf(signInWithPassword(form({ email: "owner@example.com", password: "right" })))).toBe("/dashboard");
    expect(mocks.recordSignIn).toHaveBeenCalledWith("password", "u2");
  });
});

describe("/signin/code", () => {
  it("is where the code is typed, once one is on its way", async () => {
    mocks.jar.set(PENDING_SIGNIN_COOKIE, "owner@example.com");
    const html = renderToStaticMarkup((await SignInCodePage({ searchParams: Promise.resolve({ step: "code", next: "/dashboard" }) })) as ReactElement);
    expect(html).toContain("Check your email");
    expect(html).toContain('href="/signin?next=%2Fdashboard"');
  });

  it("sends anyone without a code on its way to /signin's form, keeping next and the error", async () => {
    expect(await redirectOf(SignInCodePage({ searchParams: Promise.resolve({ next: "/articles?status=review" }) }))).toBe("/signin?next=%2Farticles%3Fstatus%3Dreview");
    expect(await redirectOf(SignInCodePage({ searchParams: Promise.resolve({ step: "code", error: "Enter the code from the email." }) }))).toBe(
      "/signin?error=Enter+the+code+from+the+email.",
    );
  });
});
