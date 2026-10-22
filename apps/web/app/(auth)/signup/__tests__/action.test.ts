import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

/**
 * The signup action, run for real with every edge mocked: the database, the
 * confirmation email, the DNS check and the event recorder. page.test.tsx
 * covers what the page renders; this covers what the action does with the
 * source it is handed:
 *
 *   * a new account writes exactly one `info` row (`stage: "created"`) with
 *     the source in its context, and "source unknown" when there is none,
 *   * a repeat submit that reuses the first submit's account writes none,
 *   * every error redirect back to /signup keeps the source params, and
 *   * the failure events carry the same `src/ref/utm` as the success row.
 *
 * The action is not exported (a page module may only export what Next allows),
 * so it is read off the `<form action>` the page renders.
 */

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    // Next's own `redirect` throws; nothing after it may run.
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  createServiceClient: vi.fn(),
  sendSignupConfirmation: vi.fn(),
  checkDomainReachable: vi.fn(),
  recordEvent: vi.fn(),
  existingSignup: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.cookieSet }), headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock("@/lib/email/auth-emails", () => ({ sendSignupConfirmation: mocks.sendSignupConfirmation }));
vi.mock("@/lib/domain/reachable", () => ({ checkDomainReachable: mocks.checkDomainReachable }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: mocks.recordEvent }));
vi.mock("@/lib/auth/signup-reuse", () => ({ existingSignup: mocks.existingSignup }));

import SignUpPage from "../page";
import { AddressTakenError } from "@/lib/auth/address-taken";
import { TAKEN_SIGNUP_COOKIE } from "@/lib/auth/pending-signup";

type Result = { data?: unknown; error: { message: string; code?: string } | null };

/**
 * A service client whose inserts answer from `results`, keyed by table. Every
 * builder method returns the builder, and awaiting it gives the table's result.
 */
function fakeAdmin(results: Partial<Record<"accounts" | "account_members" | "workspaces", Result>>) {
  const inserts: { table: string; row: unknown }[] = [];
  const from = (table: keyof typeof results) => {
    const result = results[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {
      insert: (row: unknown) => {
        inserts.push({ table, row });
        return builder;
      },
      select: () => builder,
      single: () => builder,
      then: (resolve: (v: Result) => unknown) => resolve(result),
    };
    return builder;
  };
  return { client: { from }, inserts };
}

/** Find the signup form in what the page renders and return its action. */
async function signUpAction(): Promise<(formData: FormData) => Promise<void>> {
  const tree = await SignUpPage({ searchParams: Promise.resolve({}) });
  const find = (node: ReactNode): ((formData: FormData) => Promise<void>) | null => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    }
    if (!node || typeof node !== "object" || !("props" in node)) return null;
    const element = node as ReactElement<{ action?: unknown; children?: ReactNode }>;
    if (element.type === "form" && typeof element.props.action === "function") {
      return element.props.action as (formData: FormData) => Promise<void>;
    }
    return find(element.props.children);
  };
  const action = find(tree);
  if (!action) throw new Error("no <form action> on /signup");
  return action;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const BASE = { domain: "acme.com", email: "owner@acme.com", password: "not-a-real-password" };
const SOURCE = { src: "/pricing/", ref: "news.ycombinator.com", utm_source: "newsletter", utm_campaign: "oct" };
const CARRY = "&src=%2Fpricing%2F&ref=news.ycombinator.com&utm_source=newsletter&utm_campaign=oct";
const ATTRIBUTION = { src: "/pricing/", ref: "news.ycombinator.com", utm: { source: "newsletter", campaign: "oct" } };

/** Run the action and return the URL it redirected to. */
async function submit(fields: Record<string, string>): Promise<string> {
  const action = await signUpAction();
  await expect(action(form(fields))).rejects.toThrow(/^NEXT_REDIRECT /);
  const calls = mocks.redirect.mock.calls;
  return calls[calls.length - 1][0] as string;
}

const infoRows = () =>
  mocks.recordEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.level === "info" && event.source === "signup");

let admin: ReturnType<typeof fakeAdmin>;

beforeEach(() => {
  vi.clearAllMocks();
  admin = fakeAdmin({ accounts: { data: { id: "acc-1" }, error: null } });
  mocks.createServiceClient.mockImplementation(() => admin.client);
  mocks.sendSignupConfirmation.mockResolvedValue("user-1");
  mocks.checkDomainReachable.mockResolvedValue({ ok: true });
  mocks.recordEvent.mockResolvedValue(true);
  mocks.existingSignup.mockResolvedValue({ accountId: null, workspaceId: null });
});

describe("the domain step on its own", () => {
  it("checks the domain and comes back on the email step, creating nothing", async () => {
    const url = await submit({ domain: "acme.com", ...SOURCE });
    expect(url).toBe("/signup?domain=acme.com" + CARRY);
    expect(mocks.checkDomainReachable).toHaveBeenCalledWith("acme.com");
    expect(mocks.sendSignupConfirmation).not.toHaveBeenCalled();
  });
});

describe("a new account records where it came from, once", () => {
  it("writes one info row with the source in its context", async () => {
    const url = await submit({ ...BASE, ...SOURCE });

    expect(url).toBe("/signup/verify");
    expect(mocks.recordEvent).toHaveBeenCalledOnce();
    expect(infoRows()).toEqual([
      {
        level: "info",
        source: "signup",
        message: "Account created, from /pricing/ via news.ycombinator.com, utm_source newsletter, utm_campaign oct",
        accountId: "acc-1",
        context: { stage: "created", userId: "user-1", domain: "acme.com", ...ATTRIBUTION },
      },
    ]);
  });

  it("still writes the row when nothing was sent, as source unknown", async () => {
    await submit(BASE);

    const rows = infoRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("Account created, source unknown");
    expect(rows[0].context).toEqual({ stage: "created", userId: "user-1", domain: "acme.com" });
  });

  it("writes nothing for a repeat submit that reuses the first submit's account", async () => {
    mocks.existingSignup.mockResolvedValue({ accountId: "acc-1", workspaceId: "ws-1" });

    const url = await submit({ ...BASE, ...SOURCE });

    expect(url).toBe("/signup/verify");
    expect(mocks.recordEvent).not.toHaveBeenCalled();
    expect(admin.inserts).toEqual([]);
  });

  it("records the source on the warning when the first site cannot be created", async () => {
    admin = fakeAdmin({
      accounts: { data: { id: "acc-1" }, error: null },
      workspaces: { error: { message: "boom" } },
    });

    await submit({ ...BASE, ...SOURCE });

    expect(infoRows()).toHaveLength(1);
    const warn = mocks.recordEvent.mock.calls.map(([e]) => e).find((e) => e.level === "warn");
    expect(warn?.context).toEqual({ stage: "workspace", userId: "user-1", domain: "acme.com", ...ATTRIBUTION });
  });
});

describe("every error redirect back to /signup keeps the source", () => {
  it("a domain that is not a domain", async () => {
    const url = await submit({ ...BASE, ...SOURCE, domain: "not a domain" });
    expect(url).toBe(
      "/signup?error=" + encodeURIComponent("Enter your website as a domain, like acme.com.") + CARRY,
    );
    expect(mocks.sendSignupConfirmation).not.toHaveBeenCalled();
  });

  it("a domain with no DNS", async () => {
    mocks.checkDomainReachable.mockResolvedValue({ ok: false, reason: "No such site." });
    const url = await submit({ ...BASE, ...SOURCE });
    expect(url).toBe("/signup?error=" + encodeURIComponent("No such site.") + "&domain=acme.com" + CARRY);
  });

  it("an address that already has an account: a sign-in code is offered, the address kept out of the URL", async () => {
    mocks.sendSignupConfirmation.mockRejectedValue(new AddressTakenError("A user with this email address has already been registered"));
    const url = await submit({ ...BASE, email: " Owner@Acme.com ", ...SOURCE });
    expect(url).toBe("/signup?taken=1" + CARRY);
    expect(url).not.toContain("acme.com");
    expect(mocks.cookieSet).toHaveBeenCalledWith(TAKEN_SIGNUP_COOKIE, "owner@acme.com", expect.objectContaining({ httpOnly: true, path: "/signup" }));
    // Nothing is created for it.
    expect(admin.inserts).toEqual([]);
  });

  it("a confirmation email that could not be sent", async () => {
    mocks.sendSignupConfirmation.mockRejectedValue(new Error("smtp down"));
    const url = await submit({ ...BASE, ...SOURCE });
    expect(url.startsWith("/signup?error=")).toBe(true);
    expect(url.endsWith(CARRY)).toBe(true);
  });

  it("an account row that could not be created, with the source on its event", async () => {
    admin = fakeAdmin({ accounts: { data: null, error: { message: "db down", code: "XX000" } } });
    const url = await submit({ ...BASE, ...SOURCE });

    expect(url).toBe("/signup?error=" + encodeURIComponent("Could not set up your workspace: db down") + CARRY);
    expect(mocks.recordEvent).toHaveBeenCalledOnce();
    expect(mocks.recordEvent.mock.calls[0][0]).toMatchObject({
      level: "error",
      context: { stage: "account", userId: "user-1", domain: "acme.com", ...ATTRIBUTION },
    });
    expect(infoRows()).toEqual([]);
  });

  it("a membership that could not be created, with the source on its event", async () => {
    admin = fakeAdmin({
      accounts: { data: { id: "acc-1" }, error: null },
      account_members: { error: { message: "fk" } },
    });
    const url = await submit({ ...BASE, ...SOURCE });

    expect(url).toBe(
      "/signup?error=" + encodeURIComponent("Could not finish setting up your account: fk") + CARRY,
    );
    expect(mocks.recordEvent).toHaveBeenCalledOnce();
    expect(mocks.recordEvent.mock.calls[0][0]).toMatchObject({
      level: "error",
      context: { stage: "member", userId: "user-1", domain: "acme.com", ...ATTRIBUTION },
    });
    expect(infoRows()).toEqual([]);
  });
});
