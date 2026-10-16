import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

// ---------------------------------------------------------------------------
// Creating a blog key
// ---------------------------------------------------------------------------
//
// A blog key carries only the `blog` scope and the one site it reads, which
// must be on the creator's account. Agent keys are made as before.

const SITE = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_SITE = "33333333-3333-4333-8333-333333333333";

let service: FakeSupabase;
let insertError: { code: string; message: string } | null = null;
const announced: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve({ data: { workspace_ids: null }, error: null }),
      });
      return q;
    },
  }),
  createServiceClient: () => ({
    from: (table: string) => {
      const q = service.from(table) as Record<string, (...a: unknown[]) => unknown>;
      if (table === "api_keys" && insertError) {
        const err = insertError;
        q.insert = () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: err }) }) });
      }
      return q;
    },
  }),
}));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ accountId: "acc-1", role: "owner", user: { id: "u-owner", email: "owner@acme.test", user_metadata: {} } })),
}));
vi.mock("@/lib/billing/body-lock", () => ({ sessionTrialGate: vi.fn(async () => "open") }));
vi.mock("@/lib/email/account-events", () => ({
  announceApiKeyCreated: vi.fn(async (opts: Record<string, unknown>) => {
    announced.push(opts);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createApiKey } = await import("../api-keys");

beforeEach(() => {
  insertError = null;
  announced.length = 0;
  service = fakeSupabase({
    api_keys: [],
    workspaces: [
      { id: SITE, account_id: "acc-1", domain: "client-a.example" },
      { id: OTHER_ACCOUNT_SITE, account_id: "acc-2", domain: "someone-else.example" },
    ],
  });
});

function form(fields: Record<string, string>) {
  const fd = new FormData();
  fd.set("name", "Client A blog");
  fd.set("expires_in_days", "never");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("createApiKey for a blog key", () => {
  it("stores only the blog scope and the site, and hands back the site for the env lines", async () => {
    const created = await createApiKey(form({ kind: "blog", workspace_id: SITE, allow_write: "on" }));
    expect(created.scopes).toEqual(["blog"]);
    expect(created.workspace_id).toBe(SITE);
    const row = service.tables.api_keys[0];
    expect(row).toMatchObject({ account_id: "acc-1", scopes: ["blog"], workspace_id: SITE });
    expect(announced[0]).toMatchObject({ blogSite: "client-a.example", canWrite: false });
  });

  it("refuses a site on another account, before writing", async () => {
    await expect(createApiKey(form({ kind: "blog", workspace_id: OTHER_ACCOUNT_SITE }))).rejects.toThrow(/not on this account/);
    expect(service.tables.api_keys).toHaveLength(0);
  });

  it("needs a site", async () => {
    await expect(createApiKey(form({ kind: "blog" }))).rejects.toThrow(/Choose the site/);
  });

  it("says so plainly when the database update is not applied yet", async () => {
    insertError = { code: "PGRST204", message: "Could not find the 'workspace_id' column of 'api_keys' in the schema cache" };
    await expect(createApiKey(form({ kind: "blog", workspace_id: SITE }))).rejects.toThrow(/database update/);
  });
});

describe("createApiKey for an agent key", () => {
  it("is unchanged: read and generate, no site", async () => {
    const created = await createApiKey(form({}));
    expect(created.scopes).toEqual(["read", "generate"]);
    expect(created.workspace_id).toBeNull();
    expect(service.tables.api_keys[0]).not.toHaveProperty("workspace_id");
  });

  it("ignores a site sent with it: only a blog key is bound to one", async () => {
    const created = await createApiKey(form({ workspace_id: SITE, allow_write: "on" }));
    expect(created.scopes).toEqual(["read", "generate", "write"]);
    expect(created.workspace_id).toBeNull();
    expect(service.tables.api_keys[0]).not.toHaveProperty("workspace_id");
  });

  it("refuses a kind it does not know, before writing", async () => {
    await expect(createApiKey(form({ kind: "admin", workspace_id: SITE }))).rejects.toThrow();
    expect(service.tables.api_keys).toHaveLength(0);
  });
});
