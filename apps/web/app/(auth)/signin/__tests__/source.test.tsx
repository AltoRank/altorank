// Sign-in is a door to signup twice over: its "Sign up" link, and the sign-in
// code, which makes an account for an address that has none. Both hand on
// where the visitor came from (lib/auth/signup-source.ts), or every signup by
// way of sign-in reads "source unknown".

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let requestHeaders: Record<string, string> = {};
let pendingEmail: string | undefined;
const { sendSignInCode, startSigninCodeSignup } = vi.hoisted(() => ({
  sendSignInCode: vi.fn(async () => ({ sent: true, createdUserId: "u-new" as string | null })),
  startSigninCodeSignup: vi.fn(async () => "acct-new"),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(requestHeaders),
  cookies: async () => ({
    get: () => (pendingEmail ? { value: pendingEmail } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/email/auth-emails", () => ({ sendSignInCode }));
vi.mock("@/lib/auth/signin-code-signup", () => ({ startSigninCodeSignup }));

import SignInPage from "../page";
import SignInCodePage from "../code/page";

beforeEach(() => {
  requestHeaders = { host: "app.altorank.co" };
  pendingEmail = undefined;
  sendSignInCode.mockClear();
  startSigninCodeSignup.mockClear();
});

async function signinHtml(params: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve(params) }));
}

function hrefOf(html: string, label: string): URL {
  const match = html.match(new RegExp(`<a [^>]*href="([^"]*)"[^>]*>${label}</a>`));
  if (!match) throw new Error(`no link "${label}"`);
  return new URL(match[1].replaceAll("&amp;", "&"), "https://app.altorank.co");
}

const hidden = (html: string) =>
  [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]);

describe("/signin hands the source on", () => {
  it("forwards src, lp, ref and utm to Sign up and to the sign-in code", async () => {
    const html = await signinHtml({ src: "/pricing/", lp: "/alternatives/outrank/", ref: "www.google.com", utm_source: "x" });
    const signup = hrefOf(html, "Sign up");
    expect(signup.pathname).toBe("/signup");
    expect(Object.fromEntries(signup.searchParams)).toEqual({
      src: "/pricing/",
      lp: "/alternatives/outrank/",
      ref: "www.google.com",
      utm_source: "x",
    });
    const code = hrefOf(html, "Email me a sign-in code");
    expect(code.pathname).toBe("/signin/code");
    expect(code.searchParams.get("lp")).toBe("/alternatives/outrank/");
    // And through a failed password attempt.
    expect(hidden(html)).toEqual([
      ["src", "/pricing/"],
      ["lp", "/alternatives/outrank/"],
      ["ref", "www.google.com"],
      ["utm_source", "x"],
    ]);
  });

  it("leaves both links bare when there is nothing to carry", async () => {
    const html = await signinHtml({});
    expect(hrefOf(html, "Sign up").search).toBe("");
    expect(hrefOf(html, "Email me a sign-in code").search).toBe("");
  });

  it("takes `ref` from the Referer when the visitor came straight from another site", async () => {
    requestHeaders.referer = "https://chatgpt.com/";
    expect(hrefOf(await signinHtml({}), "Sign up").searchParams.get("ref")).toBe("chatgpt.com");
    requestHeaders.referer = "https://app.altorank.co/dashboard";
    expect(hrefOf(await signinHtml({}), "Sign up").search).toBe("");
  });

  it("names the connect flow as the source when a connector sent them, and keeps `next` on the code link", async () => {
    const next = "/oauth/authorize?client_id=abc&state=s";
    const html = await signinHtml({ next });
    const signup = hrefOf(html, "Sign up");
    expect(signup.searchParams.get("src")).toBe("/oauth/authorize");
    expect(signup.searchParams.has("next")).toBe(false);
    const code = hrefOf(html, "Email me a sign-in code");
    expect(code.searchParams.get("next")).toBe(next);
    expect(code.searchParams.get("src")).toBe("/oauth/authorize");
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

// The page's server action, found in what the page rendered.
function formAction(node: ReactNode): ((form: FormData) => Promise<void>) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = formAction(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<{ action?: unknown; children?: ReactNode }>;
  if (el.type === "form" && typeof el.props.action === "function") return el.props.action as (form: FormData) => Promise<void>;
  return formAction(el.props.children);
}

describe("/signin/code records the source on the signup it makes", () => {
  async function codePage(params: Record<string, string>) {
    return SignInCodePage({ searchParams: Promise.resolve(params) });
  }

  it("carries the source from its URL into the request form", async () => {
    const html = renderToStaticMarkup(await codePage({ src: "/pricing/", lp: "/blog/x/", ref: "www.google.com" }));
    expect(hidden(html)).toEqual([
      ["src", "/pricing/"],
      ["lp", "/blog/x/"],
      ["ref", "www.google.com"],
    ]);
  });

  it("passes it to the signup when the code made a new user", async () => {
    const request = formAction(await codePage({}))!;
    const form = new FormData();
    form.set("email", "new@x.example");
    form.set("src", "/pricing/");
    form.set("lp", "/alternatives/outrank/");
    form.set("ref", "www.google.com");
    await expect(request(form)).rejects.toMatchObject({ to: "/signin/code?step=code" });
    expect(startSigninCodeSignup).toHaveBeenCalledWith("u-new", "new@x.example", {
      src: "/pricing/",
      lp: "/alternatives/outrank/",
      ref: "www.google.com",
    });
  });

  it("keeps the source across a retry", async () => {
    const request = formAction(await codePage({}))!;
    const form = new FormData();
    form.set("email", "not-an-address");
    form.set("lp", "/blog/x/");
    const err = (await request(form).catch((e: unknown) => e)) as { to: string };
    const back = new URL(err.to, "https://app.altorank.co");
    expect(back.searchParams.get("error")).toBe("Enter your email address.");
    expect(back.searchParams.get("lp")).toBe("/blog/x/");
  });

  it("takes `ref` from the Referer on the request form, and carries nothing on the code step", async () => {
    requestHeaders.referer = "https://claude.ai/";
    expect(hidden(renderToStaticMarkup(await codePage({})))).toEqual([["ref", "claude.ai"]]);
    pendingEmail = "new@x.example";
    expect(hidden(renderToStaticMarkup(await codePage({ step: "code", lp: "/blog/x/" })))).toEqual([]);
  });
});
