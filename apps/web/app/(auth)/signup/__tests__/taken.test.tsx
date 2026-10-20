import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /signup?taken=1: a signup refused because the address already has an
 * account. Most returning owners have no password they know since code
 * signup, so the page offers a sign-in code to the address they typed, which
 * the signup left in a cookie, never in the URL.
 */

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  emailSignInCode: vi.fn(async (..._a: unknown[]) => undefined),
  jar: new Map<string, string>(),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { value: mocks.jar.get(name) } : undefined),
    set: (name: string, value: string) => void mocks.jar.set(name, value),
    delete: ({ name }: { name: string }) => void mocks.jar.delete(name),
  }),
}));
vi.mock("@/lib/auth/code-signin", () => ({ emailSignInCode: mocks.emailSignInCode }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));
vi.mock("@/lib/email/auth-emails", () => ({ sendSignupConfirmation: vi.fn() }));

import SignUpPage from "../page";
import { TAKEN_SIGNUP_COOKIE } from "@/lib/auth/pending-signup";

const render = async (params: Record<string, string>) => {
  const tree = await SignUpPage({ searchParams: Promise.resolve(params) });
  return { tree, html: renderToStaticMarkup(tree as ReactElement) };
};

function formAction(node: ReactNode): (() => Promise<void>) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = formAction(child);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const element = node as ReactElement<{ action?: unknown; children?: ReactNode }>;
  if (element.type === "form" && typeof element.props.action === "function") return element.props.action as () => Promise<void>;
  return formAction(element.props.children);
}

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

beforeEach(() => {
  mocks.jar.clear();
  mocks.emailSignInCode.mockReset();
  mocks.redirect.mockClear();
});

describe("/signup?taken=1", () => {
  it("says the address has an account and offers a code, a password, or another address", async () => {
    mocks.jar.set(TAKEN_SIGNUP_COOKIE, "owner@example.com");
    const { html } = await render({ taken: "1", src: "/pricing/" });
    expect(html).toMatch(/<div role="alert"[^>]*>You already have an account with <span[^>]*>owner@example\.com<\/span>\. We can email you a sign-in code\.<\/div>/);
    expect(html).toContain(">Email me a sign-in code</button>");
    expect(html).toContain('href="/signin?method=password"');
    expect(html).toContain('href="/signup?src=%2Fpricing%2F"');
    // The signup form itself is not offered again over it.
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain("already been registered");
  });

  it("still says it when the cookie has run out, without the address", async () => {
    const { html } = await render({ taken: "1" });
    expect(html).toContain("You already have an account with this address.");
  });

  it("emails the code to the address the signup was refused for, then opens the code page", async () => {
    mocks.jar.set(TAKEN_SIGNUP_COOKIE, "owner@example.com");
    const action = formAction((await render({ taken: "1" })).tree);
    expect(await redirectOf(action!())).toBe("/signin/code?step=code");
    expect(mocks.emailSignInCode).toHaveBeenCalledWith("owner@example.com", "/dashboard");
    expect(mocks.jar.has(TAKEN_SIGNUP_COOKIE)).toBe(false);
  });

  it("sends a run-out cookie to /signin to ask for the address, emailing nobody", async () => {
    const action = formAction((await render({ taken: "1" })).tree);
    expect(await redirectOf(action!())).toBe("/signin");
    expect(mocks.emailSignInCode).not.toHaveBeenCalled();
  });

  it("says so on /signin's code form when the code could not be sent", async () => {
    mocks.jar.set(TAKEN_SIGNUP_COOKIE, "owner@example.com");
    mocks.emailSignInCode.mockRejectedValueOnce(new Error("provider down"));
    const action = formAction((await render({ taken: "1" })).tree);
    expect(await redirectOf(action!())).toBe("/signin?error=The+code+could+not+be+sent.+Try+again+in+a+minute.");
  });
});
