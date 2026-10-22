// Sign-in is a door to signup twice over: its "Sign up" link, and the sign-in
// code, which makes an account for an address that has none. Both hand on
// where the visitor came from (lib/auth/signup-source.ts), or every signup by
// way of sign-in reads "source unknown".

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let requestHeaders: Record<string, string> = {};
const mocks = vi.hoisted(() => ({
  sendSignInCode: vi.fn(async (..._a: unknown[]): Promise<{ sent: boolean; createdUserId: string | null }> => ({ sent: true, createdUserId: "u-new" })),
  startSigninCodeSignup: vi.fn(async (..._a: unknown[]) => "acct-new"),
  signInWithPassword: vi.fn(),
  jar: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(requestHeaders),
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { value: mocks.jar.get(name) } : undefined),
    set: (name: string, value: string) => void mocks.jar.set(name, value),
    delete: ({ name }: { name: string }) => void mocks.jar.delete(name),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signInWithPassword: mocks.signInWithPassword } }) }));
vi.mock("@/lib/email/auth-emails", () => ({ sendSignInCode: mocks.sendSignInCode }));
vi.mock("@/lib/auth/signin-code-signup", () => ({ startSigninCodeSignup: mocks.startSigninCodeSignup }));
vi.mock("@/lib/auth/signin-event", () => ({ recordSignIn: async () => undefined }));

import SignInPage from "../page";
import SignInCodePage from "../code/page";
import { requestSignInCode, signInWithPassword } from "../actions";
import { PENDING_SIGNIN_COOKIE } from "@/lib/auth/pending-signin";

beforeEach(() => {
  requestHeaders = { host: "app.altorank.co" };
  mocks.jar.clear();
  mocks.sendSignInCode.mockClear();
  mocks.startSigninCodeSignup.mockClear();
  mocks.signInWithPassword.mockReset();
});

async function signinHtml(params: Record<string, string>): Promise<string> {
  return renderToStaticMarkup((await SignInPage({ searchParams: Promise.resolve(params) })) as ReactElement);
}

function hrefOf(html: string, label: string): URL {
  const match = html.match(new RegExp(`<a [^>]*href="([^"]*)"[^>]*>${label}</a>`));
  if (!match) throw new Error(`no link "${label}"`);
  return new URL(match[1].replaceAll("&amp;", "&"), "https://app.altorank.co");
}

// The source's hidden inputs; `next` has its own.
const hidden = (html: string) =>
  [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]).filter(([name]) => name !== "next");

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

async function redirectOf(run: Promise<unknown>): Promise<URL> {
  const err = (await run.then(
    () => {
      throw new Error("expected a redirect");
    },
    (e: unknown) => e,
  )) as { to?: string };
  if (!err.to) throw err;
  return new URL(err.to, "https://app.altorank.co");
}

describe("/signin hands the source on", () => {
  it("forwards src, lp, ref and utm to Sign up, and into the form that asks for a code", async () => {
    const html = await signinHtml({ src: "/pricing/", lp: "/alternatives/outrank/", ref: "www.google.com", utm_source: "x" });
    const signup = hrefOf(html, "Sign up");
    expect(signup.pathname).toBe("/signup");
    expect(Object.fromEntries(signup.searchParams)).toEqual({
      src: "/pricing/",
      lp: "/alternatives/outrank/",
      ref: "www.google.com",
      utm_source: "x",
    });
    // One form asks for the code and, a tap away, takes the password.
    expect(hidden(html)).toEqual([
      ["src", "/pricing/"],
      ["lp", "/alternatives/outrank/"],
      ["ref", "www.google.com"],
      ["utm_source", "x"],
    ]);
    // And the tap's no-JavaScript link keeps it.
    expect(hrefOf(html, "Use a password instead").searchParams.get("lp")).toBe("/alternatives/outrank/");
  });

  it("leaves the links bare when there is nothing to carry", async () => {
    const html = await signinHtml({});
    expect(hrefOf(html, "Sign up").search).toBe("");
    expect(hidden(html)).toEqual([]);
  });

  it("takes `ref` from the Referer when the visitor came straight from another site", async () => {
    requestHeaders.referer = "https://chatgpt.com/";
    expect(hrefOf(await signinHtml({}), "Sign up").searchParams.get("ref")).toBe("chatgpt.com");
    requestHeaders.referer = "https://app.altorank.co/dashboard";
    expect(hrefOf(await signinHtml({}), "Sign up").search).toBe("");
  });

  it("names the connect flow as the source when a connector sent them, and keeps `next` out of Sign up", async () => {
    const next = "/oauth/authorize?client_id=abc&state=s";
    const html = await signinHtml({ next });
    const signup = hrefOf(html, "Sign up");
    expect(signup.searchParams.get("src")).toBe("/oauth/authorize");
    expect(signup.searchParams.has("next")).toBe(false);
    expect(hidden(html)).toEqual([["src", "/oauth/authorize"]]);
    expect(html).toContain(`name="next" value="${next.replaceAll("&", "&amp;")}"`);
  });

  it("does not replace a marketing src with the connect flow's", async () => {
    const html = await signinHtml({ next: "/oauth/authorize?client_id=abc", src: "/integrations/" });
    expect(hrefOf(html, "Sign up").searchParams.get("src")).toBe("/integrations/");
  });

  it("keeps an invitation's join link as it was", async () => {
    const html = await signinHtml({ next: "/invite/tok123", src: "/pricing/" });
    expect(hrefOf(html, "Sign up").pathname).toBe("/invite/tok123/join");
  });
});

describe("the sign-in code records the source on the signup it makes", () => {
  it("passes it to the signup when the code made a new user", async () => {
    const to = await redirectOf(requestSignInCode(form({ email: "new@x.example", src: "/pricing/", lp: "/alternatives/outrank/", ref: "www.google.com" })));
    expect(to.pathname + to.search).toBe("/signin/code?step=code");
    expect(mocks.startSigninCodeSignup).toHaveBeenCalledWith("u-new", "new@x.example", {
      src: "/pricing/",
      lp: "/alternatives/outrank/",
      ref: "www.google.com",
    });
  });

  it("keeps the source across a retry, and across a code that could not be sent", async () => {
    let back = await redirectOf(requestSignInCode(form({ email: "not-an-address", lp: "/blog/x/" })));
    expect(back.pathname).toBe("/signin");
    expect(back.searchParams.get("error")).toBe("Enter your email address.");
    expect(back.searchParams.get("lp")).toBe("/blog/x/");
    mocks.sendSignInCode.mockRejectedValueOnce(new Error("provider down"));
    back = await redirectOf(requestSignInCode(form({ email: "new@x.example", ref: "claude.ai" })));
    expect(back.searchParams.get("ref")).toBe("claude.ai");
  });

  it("keeps it across a wrong password: the next step may be Sign up", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: "Invalid login credentials" } });
    const back = await redirectOf(signInWithPassword(form({ email: "a@x.example", password: "x", src: "/pricing/" })));
    expect(back.searchParams.get("method")).toBe("password");
    expect(back.searchParams.get("src")).toBe("/pricing/");
  });
});

describe("/signin/code", () => {
  it("carries nothing on the code step: the account, if any, is already made", async () => {
    mocks.jar.set(PENDING_SIGNIN_COOKIE, "new@x.example");
    const html = renderToStaticMarkup((await SignInCodePage({ searchParams: Promise.resolve({ step: "code", lp: "/blog/x/" }) })) as ReactElement);
    expect(hidden(html)).toEqual([]);
  });

  it("hands an older link's source on to /signin, whose form records it", async () => {
    const to = await redirectOf(SignInCodePage({ searchParams: Promise.resolve({ src: "/pricing/", lp: "/blog/x/" }) }));
    expect(to.pathname).toBe("/signin");
    expect(Object.fromEntries(to.searchParams)).toEqual({ src: "/pricing/", lp: "/blog/x/" });
  });
});
