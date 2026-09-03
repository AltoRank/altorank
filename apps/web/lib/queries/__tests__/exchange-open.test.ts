import { beforeEach, describe, expect, it, vi } from "vitest";

// One thenable that records every filter the query applied, so the guarantees
// that matter here can be asserted: no self-dealing, only unclaimed requests,
// nothing expired, and a fixed column list that does not leak the requester's
// agency or workspace ids.
type Call = { method: string; args: unknown[] };
let calls: Call[] = [];
let result: { data: unknown; error: unknown } = { data: [], error: null };

function chain() {
  const self: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "neq", "or", "order", "limit"]) {
    self[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return self;
    };
  }
  self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return self;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => chain() }),
  createServiceClient: () => ({ from: () => chain() }),
}));

const arg = (method: string) => calls.find((c) => c.method === method)?.args;

beforeEach(() => {
  calls = [];
  result = { data: [], error: null };
});

describe("getOpenRequests", () => {
  it("asks only for unclaimed, unexpired requests from other accounts", async () => {
    const { getOpenRequests } = await import("../exchange");
    await getOpenRequests("my-agency");

    expect(arg("eq")).toEqual(["status", "requested"]);
    expect(arg("is")).toEqual(["provider_agency_id", null]);
    // The no-self-dealing guarantee, and it is a filter rather than a column:
    // a host must not see their own request, and must not be handed anyone
    // else's agency id either.
    expect(arg("neq")).toEqual(["requester_agency_id", "my-agency"]);
    expect(String(arg("or")?.[0])).toContain("expires_at");
  });

  it("selects the request and nothing that identifies who filed it", async () => {
    const { getOpenRequests } = await import("../exchange");
    await getOpenRequests("my-agency");
    const columns = String(arg("select")?.[0]);
    for (const wanted of ["target_url", "target_keyword", "target_topic", "credits_offered"]) {
      expect(columns).toContain(wanted);
    }
    expect(columns).not.toContain("requester_agency_id");
    expect(columns).not.toContain("requester_workspace_id");
  });

  it("shapes rows for the host, defaulting what a request may omit", async () => {
    result = {
      data: [
        {
          id: "x1",
          target_url: "https://example.com/guide",
          target_keyword: null,
          target_topic: null,
          credits_offered: null,
          created_at: "2026-09-02T00:00:00Z",
          expires_at: null,
        },
      ],
      error: null,
    };
    const { getOpenRequests } = await import("../exchange");
    const out = await getOpenRequests("my-agency");
    expect(out).toEqual([
      {
        id: "x1",
        targetUrl: "https://example.com/guide",
        targetKeyword: null,
        targetTopic: null,
        creditsOffered: 0,
        createdAt: "2026-09-02T00:00:00Z",
        expiresAt: null,
      },
    ]);
  });

  it("throws rather than reporting an empty marketplace when the query fails", async () => {
    result = { data: null, error: { message: "boom" } };
    const { getOpenRequests } = await import("../exchange");
    await expect(getOpenRequests("my-agency")).rejects.toThrow("boom");
  });
});
