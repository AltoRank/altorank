import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// API keys and connector consent need access to every site
// ---------------------------------------------------------------------------
//
// A key acts for the whole account, so a member limited to some sites does not
// get one, by hand (createApiKey) or by approving a connector
// (decideAuthorization). A member with every site is unaffected.

let memberSites: string[] | null = null;
const keyInserts: Record<string, unknown>[] = [];
const issued: unknown[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve({ data: { workspace_ids: memberSites }, error: null }),
      });
      return q;
    },
  }),
  createServiceClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        keyInserts.push(row);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: "key-1" }, error: null }) }) };
      },
    }),
  }),
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    accountId: "account-1",
    role: "admin",
    user: { id: "u-admin", email: "admin@acme.test", user_metadata: {} },
  })),
}));
vi.mock("@/lib/billing/body-lock", () => ({ sessionTrialGate: vi.fn(async () => "open") }));
vi.mock("@/lib/email/account-events", () => ({ announceApiKeyCreated: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/oauth/clients", () => ({
  loadClient: vi.fn(async () => ({ id: "client-1", client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] })),
  redirectAllowed: () => true,
}));
vi.mock("@/lib/oauth/codes", () => ({
  parseScopes: () => ({ scopes: ["read", "generate"], unknown: [] }),
  issueCode: vi.fn(async (_s: unknown, input: unknown) => {
    issued.push(input);
    return "the-code";
  }),
}));

beforeEach(() => {
  memberSites = null;
  keyInserts.length = 0;
  issued.length = 0;
});

function keyForm() {
  const fd = new FormData();
  fd.set("name", "Agent");
  fd.set("expires_in_days", "never");
  return fd;
}

function consentForm() {
  const fd = new FormData();
  fd.set("client_id", "client-1");
  fd.set("redirect_uri", "https://claude.ai/cb");
  fd.set("state", "s");
  fd.set("code_challenge", "a".repeat(43));
  fd.set("decision", "approve");
  fd.set("scope", "read generate");
  return fd;
}

describe("createApiKey", () => {
  it("creates a key for a member with every site", async () => {
    const { createApiKey } = await import("../api-keys");
    await expect(createApiKey(keyForm())).resolves.toMatchObject({ id: "key-1" });
    expect(keyInserts).toHaveLength(1);
  });

  it("refuses a member limited to some sites, before writing anything", async () => {
    memberSites = ["ws-a"];
    const { createApiKey } = await import("../api-keys");
    await expect(createApiKey(keyForm())).rejects.toThrow(/every site/);
    expect(keyInserts).toHaveLength(0);
  });
});

describe("decideAuthorization", () => {
  it("issues a code for a member with every site", async () => {
    const { decideAuthorization } = await import("../../oauth/authorize/actions");
    await expect(decideAuthorization(consentForm())).rejects.toThrow(/REDIRECT https:\/\/claude\.ai\/cb\?code=the-code/);
    expect(issued).toHaveLength(1);
  });

  it("refuses a member limited to some sites, and says why to the app", async () => {
    memberSites = ["ws-a"];
    const { decideAuthorization } = await import("../../oauth/authorize/actions");
    await expect(decideAuthorization(consentForm())).rejects.toThrow(/error=access_denied.*every\+site/);
    expect(issued).toHaveLength(0);
  });
});
