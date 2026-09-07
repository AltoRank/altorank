import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// P0-O3: every refusal has to reach the dialog as text
// ---------------------------------------------------------------------------
//
// These all used to be `throw new Error(...)`, and the one caller caught,
// logged and closed the spinner - so the workspace limit, a domain already in
// the account and a malformed domain were indistinguishable from the dialog.
// Next.js also replaces a thrown server-action message with an opaque digest
// in production, so a refusal the person can read has to travel as data.

let dup: { id: string; name: string } | null = null;
let insertResult: { data: { id: string } | null; error: { message: string } | null } = {
  data: { id: "ws-new" },
  error: null,
};
const inserted = vi.fn();

// The reachability check createWorkspace runs before it writes anything does a
// real DNS lookup and a real fetch (lib/domain/reachable.ts). A unit test must
// not depend on the network: on a runner without one, three of these time out
// at the 5s default and the failure reads as a bug in the action rather than in
// the harness. Mocked to "live" so these tests keep testing what they are about
// - which refusals reach the dialog as text - and reachability keeps its own
// tests in lib/domain/__tests__.
vi.mock("@/lib/domain/reachable", () => ({
  checkDomainReachable: async (d: string) => ({ ok: true, verdict: "live", url: `https://${d}` }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "a@b.co", user_metadata: {} } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ ilike: () => ({ maybeSingle: async () => ({ data: dup }) }) }),
      }),
      insert: (row: unknown) => {
        inserted(row);
        return { select: () => ({ single: async () => insertResult }) };
      },
    }),
  }),
}));

type Allowance = import("@/lib/billing/workspaces").WorkspaceAllowance;
const PLAN_ALLOWANCE: Allowance = { limit: 3, used: 1, remaining: 2, reason: "plan", plan: "starter" };
const { allowance } = vi.hoisted(() => ({
  allowance: vi.fn<() => Promise<import("@/lib/billing/workspaces").WorkspaceAllowance>>(),
}));
vi.mock("@/lib/billing/workspaces", async () => {
  const real = await vi.importActual<typeof import("@/lib/billing/workspaces")>("@/lib/billing/workspaces");
  return { ...real, getWorkspaceAllowance: allowance };
});
vi.mock("@/lib/queries/agency", () => ({ ensureAgency: async () => "agency-1" }));
// The role gate in front of everything else: adding a site takes a plan slot,
// so it is owner/admin like the Search Console door that also creates sites.
const { requireAuth } = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({ agencyId: "agency-1", role: "owner", user: { id: "u1", email: "a@b.co" } })),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));
vi.mock("@/lib/seo/indexing", () => ({ generateIndexNowKey: () => "key" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

async function create(fields: Record<string, string>) {
  const { createWorkspace } = await import("../workspaces");
  return createWorkspace(form(fields));
}

beforeEach(() => {
  dup = null;
  insertResult = { data: { id: "ws-new" }, error: null };
  inserted.mockClear();
  allowance.mockClear();
  allowance.mockResolvedValue(PLAN_ALLOWANCE);
  requireAuth.mockClear();
  requireAuth.mockResolvedValue({ agencyId: "agency-1", role: "owner", user: { id: "u1", email: "a@b.co" } });
});

describe("createWorkspace", () => {
  it("returns the new id and the normalised domain on success", async () => {
    await expect(create({ name: "Acme Corp", domain: "https://WWW.Acme.com/blog" })).resolves.toEqual({
      ok: true,
      workspaceId: "ws-new",
      domain: "acme.com",
    });
    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({ domain: "acme.com", agency_id: "agency-1" }));
  });

  it("returns the workspace-limit message instead of throwing it", async () => {
    allowance.mockResolvedValue({ limit: 1, used: 1, remaining: 0, reason: "no-plan", plan: null });
    const result = await create({ name: "Acme", domain: "acme.com" });
    expect(result).toEqual({
      ok: false,
      error: "One workspace is included before choosing a plan. Choose a plan on the Billing page to add more sites.",
    });
    expect(inserted).not.toHaveBeenCalled();
  });

  it("names the workspace a duplicate domain already belongs to", async () => {
    dup = { id: "ws-1", name: "Acme (old)" };
    const result = await create({ name: "Acme", domain: "acme.com" });
    expect(result).toEqual({
      ok: false,
      error: 'acme.com is already the workspace "Acme (old)". One workspace per site.',
    });
    expect(inserted).not.toHaveBeenCalled();
  });

  it("returns the schema's own message for a domain that is not one", async () => {
    const result = await create({ name: "Acme", domain: "not a domain" });
    expect(result).toEqual({ ok: false, error: "Enter a domain like acme.com" });
    expect(allowance).not.toHaveBeenCalled();
  });

  it("refuses an empty name without reaching the database", async () => {
    const result = await create({ name: "", domain: "acme.com" });
    expect(result).toMatchObject({ ok: false });
    expect(inserted).not.toHaveBeenCalled();
  });

  it("surfaces a database error rather than swallowing it", async () => {
    insertResult = { data: null, error: { message: "duplicate key value violates unique constraint" } };
    await expect(create({ name: "Acme", domain: "acme.com" })).resolves.toEqual({
      ok: false,
      error: "duplicate key value violates unique constraint",
    });
  });

  it("never returns ok:false with an empty reason", async () => {
    for (const fields of [{ name: "", domain: "" }, { name: "A", domain: "??" }]) {
      const result = await create(fields);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(10);
    }
  });
});

describe("createWorkspace, who may", () => {
  it("refuses an editor in a sentence, and writes nothing", async () => {
    // This action had no role check at all, so a member scoped to a single
    // site could add a fourth site to somebody else's account - taking a plan
    // slot and starting it on the shared monthly quota - while the Team page
    // told them editors "cannot manage billing".
    requireAuth.mockResolvedValue({ agencyId: "agency-1", role: "editor", user: { id: "u2", email: "e@b.co" } });
    const result = await create({ name: "Acme", domain: "acme.com" });
    expect(result).toEqual({
      ok: false,
      error:
        "Adding a workspace changes what the account pays for, so an owner or admin has to do it. Ask one of them and it takes a moment.",
    });
    expect(inserted).not.toHaveBeenCalled();
    // Refused before the allowance is even read: this is not "the plan is
    // full", and offering an upgrade would point at a page they cannot buy on.
    expect(allowance).not.toHaveBeenCalled();
  });

  it("lets an admin add one", async () => {
    requireAuth.mockResolvedValue({ agencyId: "agency-1", role: "admin", user: { id: "u3", email: "a2@b.co" } });
    await expect(create({ name: "Acme", domain: "acme.com" })).resolves.toMatchObject({ ok: true });
  });
});
