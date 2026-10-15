import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * An invited teammate's way in, end to end with the edges mocked:
 *
 *   signed out on /invite/<t>  -> offered "Create your login" (the join form)
 *                                 and "I already have a login" (sign-in with
 *                                 `next` back to the invite)
 *   join form                  -> a login for the INVITE's address, confirmed
 *                                 by a link that returns to /invite/<t>; no
 *                                 account and no site are created
 *   signed in on /invite/<t>   -> membership written, then /dashboard, not `/`
 *                                 (next.config.ts sends `/` to the marketing site)
 *   /signin?next=/invite/<t>   -> "Sign up" points at the join form
 */

const TOKEN = "abc123def456";
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  getUser: vi.fn(),
  sendSignupConfirmation: vi.fn(),
  inserts: [] as { table: string; row: unknown }[],
  invite: null as Record<string, unknown> | null,
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/email/auth-emails", () => ({ sendSignupConfirmation: mocks.sendSignupConfirmation }));
vi.mock("@/lib/supabase/server", () => {
  const admin = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        update: () => builder,
        insert: (row: unknown) => {
          mocks.inserts.push({ table, row });
          return builder;
        },
        maybeSingle: async () => ({
          data: table === "invites" ? mocks.invite : table === "accounts" ? { name: "Acme Agency" } : null,
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      };
      return builder;
    },
  };
  return {
    createServiceClient: () => admin,
    createClient: async () => ({ auth: { getUser: mocks.getUser } }),
  };
});

import InvitePage from "../page";
import JoinPage from "../join/page";
import SignInPage from "../../../signin/page";

function findAction(node: ReactNode): ((fd: FormData) => Promise<void>) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findAction(child);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const el = node as ReactElement<{ action?: unknown; children?: ReactNode }>;
  if (el.type === "form" && typeof el.props.action === "function") return el.props.action as (fd: FormData) => Promise<void>;
  return findAction(el.props.children);
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  await expect(p).rejects.toThrow(/^NEXT_REDIRECT /);
  const calls = mocks.redirect.mock.calls;
  return calls[calls.length - 1][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserts.length = 0;
  mocks.invite = {
    id: "inv-1",
    account_id: "acc-1",
    email: "Teammate@Example.com",
    role: "editor",
    workspace_ids: ["ws-1"],
    expires_at: FUTURE,
  };
  mocks.sendSignupConfirmation.mockResolvedValue("user-2");
});

describe("/invite/<token>, signed out", () => {
  it("offers a login for the invited address and a sign-in that returns to the invite", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const html = renderToStaticMarkup((await InvitePage({ params: Promise.resolve({ token: TOKEN }) })) as ReactElement);
    expect(html).toContain("Join Acme Agency");
    expect(html).toContain(`href="/invite/${TOKEN}/join"`);
    expect(html).toContain(`href="/signin?next=%2Finvite%2F${TOKEN}"`);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.inserts).toEqual([]);
  });
});

describe("/invite/<token>, signed in as the invited address", () => {
  it("adds the membership and lands on the dashboard, not the marketing root", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-2", email: "teammate@example.com" } } });
    const url = await redirectOf(InvitePage({ params: Promise.resolve({ token: TOKEN }) }));
    expect(url).toBe("/dashboard");
    expect(mocks.inserts).toEqual([
      { table: "account_members", row: { account_id: "acc-1", user_id: "user-2", role: "editor", workspace_ids: ["ws-1"] } },
    ]);
  });
});

describe("/invite/<token>/join", () => {
  it("creates a login for the invite's address only, confirmed back to the invite, with no account or site", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const tree = await JoinPage({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain("Teammate@Example.com");
    expect(html).not.toMatch(/name="domain"/);

    const action = findAction(tree);
    expect(action).toBeTruthy();
    const fd = new FormData();
    fd.set("token", TOKEN);
    fd.set("password", "long-enough-pw");
    fd.set("name", "Sam");
    // A typed address is ignored: the login is for the invited one.
    fd.set("email", "someone-else@example.com");
    const url = await redirectOf(action!(fd));

    expect(url).toBe(`/invite/${TOKEN}/join?sent=1`);
    expect(mocks.sendSignupConfirmation).toHaveBeenCalledWith({
      email: "Teammate@Example.com",
      password: "long-enough-pw",
      name: "Sam",
      next: `/invite/${TOKEN}`,
      invitedTo: "Acme Agency",
    });
    expect(mocks.inserts).toEqual([]);
  });

  it("sends an address that already has a login to sign in", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    mocks.sendSignupConfirmation.mockRejectedValue(new Error("A user with this email address has already been registered"));
    const action = findAction(await JoinPage({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve({}) }));
    const fd = new FormData();
    fd.set("token", TOKEN);
    fd.set("password", "long-enough-pw");
    const url = await redirectOf(action!(fd));
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain("already has a login");
  });

  it("refuses a used or unknown token by returning to the invite page", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    mocks.invite = null;
    const url = await redirectOf(JoinPage({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve({}) }));
    expect(url).toBe(`/invite/${TOKEN}`);
  });
});

describe("/signin with an invite as `next`", () => {
  it("points Sign up at the invitee's join form", async () => {
    const html = renderToStaticMarkup(
      (await SignInPage({ searchParams: Promise.resolve({ next: `/invite/${TOKEN}` }) })) as ReactElement,
    );
    expect(html).toContain(`href="/invite/${TOKEN}/join"`);
    expect(html).toContain(`name="next" value="/invite/${TOKEN}"`);
  });

  it("keeps the owner signup otherwise", async () => {
    const html = renderToStaticMarkup((await SignInPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(html).toContain('href="/signup"');
  });
});
