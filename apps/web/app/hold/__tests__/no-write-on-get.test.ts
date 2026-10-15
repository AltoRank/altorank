// ---------------------------------------------------------------------------
// A GET must not hold anything
// ---------------------------------------------------------------------------
//
// /hold wrote the hold while rendering, and mail security scanners fetch every
// link in an inbound message before the recipient sees it: on a corporate
// tenant every auto-approve draft was held before anyone read the email. The
// write moved to the confirm button's POST, which re-checks the signature.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

let db: FakeSupabase & { auth: { admin: { getUserById: (id: string) => Promise<unknown> } } };

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db }));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));

import HoldPage from "../page";
import { holdFromEmail } from "../actions";
import { signHold } from "@/lib/publishing/hold-link";

const ARTICLE = "11111111-2222-4333-8444-555555555555";
const EMAIL = "owner@acme.example";

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});
afterAll(() => {
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

beforeEach(() => {
  redirect.mockClear();
  const base = fakeSupabase({
    workspaces: [{ id: "ws-1", account_id: "acc-1", domain: "acme.example" }],
    // The embedded `workspaces(...)` the page selects, as PostgREST returns it
    // (the fake resolves only `alias:table(...)` joins).
    articles: [{ id: ARTICLE, workspace_id: "ws-1", title: "Spring guide", status: "review", held_by: null, workspaces: { account_id: "acc-1", domain: "acme.example" } }],
    account_members: [{ account_id: "acc-1", user_id: "u-owner" }],
  });
  db = Object.assign(base, {
    auth: {
      ...base.auth,
      admin: { getUserById: async (id: string) => ({ data: { user: id === "u-owner" ? { email: EMAIL } : null } }) },
    },
  });
});

const link = () => ({ a: ARTICLE, e: EMAIL, s: signHold(ARTICLE, EMAIL)! });
const article = () => db.tables.articles[0];

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("GET /hold", () => {
  it("writes nothing: a link scanner fetching it holds no draft", async () => {
    await HoldPage({ searchParams: Promise.resolve(link()) });
    expect(db.writes).toEqual([]);
    expect(article().held_by).toBeNull();
  });
});

describe("the Hold it button (POST)", () => {
  it("records the hold against the member whose address was signed", async () => {
    await expect(holdFromEmail(form(link()))).rejects.toThrow("NEXT_REDIRECT");
    expect(article()).toMatchObject({ held_by: "u-owner", auto_approve_hold_reason: "held by a person" });
  });

  it("re-checks the signature: a forged form holds nothing", async () => {
    await expect(holdFromEmail(form({ ...link(), s: "0".repeat(32) }))).rejects.toThrow("NEXT_REDIRECT");
    expect(db.writes).toEqual([]);
  });

  it("re-checks the draft: one that left review in the meantime is not touched", async () => {
    article().status = "scheduled";
    await expect(holdFromEmail(form(link()))).rejects.toThrow("NEXT_REDIRECT");
    expect(db.writes).toEqual([]);
  });
});
