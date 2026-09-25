import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/internal/resume-drafting: what a checkout opens, in its own
 * invocation. Server to server, so the cron secret is its whole
 * authorisation; the work itself is lib/plan/resume-week.ts.
 */

const { resumeAccount, deferred } = vi.hoisted(() => ({
  resumeAccount: vi.fn(),
  deferred: [] as Array<() => unknown>,
}));
vi.mock("next/server", async () => {
  const real = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...real, after: (fn: () => unknown) => { deferred.push(fn); } };
});
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ service: true }) }));
vi.mock("@/lib/plan/resume-week", () => ({ resumeAccount: (...a: unknown[]) => resumeAccount(...a) }));

import { POST } from "../resume-drafting/route";

function post(body: unknown, headers: Record<string, string> = { "x-cron-secret": "cron-secret" }) {
  return POST(
    new Request("https://app.example/api/internal/resume-drafting", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as never,
  );
}

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  deferred.length = 0;
  resumeAccount.mockReset().mockResolvedValue({ accountId: "acc1", sites: [{ workspaceId: "ws1", topUp: 20 }], settled: Promise.resolve() });
});

describe("POST /api/internal/resume-drafting", () => {
  it("refuses anyone without the cron secret, including a bearer guess", async () => {
    expect((await post({ accountId: "acc1", key: "sub_1", draftWeek: true }, {})).status).toBe(401);
    expect((await post({ accountId: "acc1", key: "sub_1", draftWeek: true }, { authorization: "Bearer guess" })).status).toBe(401);
    expect(resumeAccount).not.toHaveBeenCalled();
  });

  it("accepts the scheduler's bearer form of the same secret", async () => {
    expect((await post({ accountId: "acc1", key: "sub_1", draftWeek: true }, { authorization: "Bearer cron-secret" })).status).toBe(200);
  });

  it("refuses when no secret is configured at all: an unset secret must not open the door", async () => {
    delete process.env.CRON_SECRET;
    expect((await post({ accountId: "acc1", key: "sub_1", draftWeek: true })).status).toBe(401);
  });

  it("needs the account and the checkout key", async () => {
    expect((await post("{")).status).toBe(400);
    expect((await post({ accountId: "acc1" })).status).toBe(400);
    expect((await post({ key: "sub_1" })).status).toBe(400);
    expect(resumeAccount).not.toHaveBeenCalled();
  });

  it("runs the resume for the account, drafting the week only when asked, and keeps its requests alive", async () => {
    const res = await post({ accountId: "acc1", key: "sub_1", draftWeek: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: "acc1", sites: [{ workspaceId: "ws1", topUp: 20 }] });
    expect(resumeAccount).toHaveBeenCalledWith({ service: true }, "acc1", { key: "sub_1", draftWeek: true });
    expect(deferred).toHaveLength(1);

    await post({ accountId: "acc1", key: "sub_2", draftWeek: "yes" });
    expect(resumeAccount.mock.calls[1][2]).toEqual({ key: "sub_2", draftWeek: false });
  });
});
