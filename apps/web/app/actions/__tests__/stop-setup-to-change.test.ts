import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDb } from "@/lib/onboarding/__tests__/fake-runs-client";

// ---------------------------------------------------------------------------
// "Wrong? Fix it and start over": who may, and when
// ---------------------------------------------------------------------------
//
// The panel beside a live first look offers to stop it and change what it was
// started on (lib/onboarding/stop-to-change.ts). The run screen asks
// `mayStartSetupOver` once the run exists, and the link calls
// `stopSetupToChange`. Pinned here: the spend gate is asked with the live run
// counted (so the last pre-trial setup run is never stopped), only the owner
// may, not while viewing as the account, and only a run still reading the
// site is closed.

const canSpend = vi.fn();
vi.mock("@/lib/billing/spend-gate", async (real) => ({ ...(await real<object>()), canSpend: (...a: unknown[]) => canSpend(...a) }));
const auth = vi.hoisted(() => ({ role: "owner" }));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: async () => ({ accountId: "ag1", role: auth.role, user: { id: "u1", email: "owner@acme-agency.example" } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/email/lifecycle", () => ({ notifySetupFailed: vi.fn(), notifyOperatorsNothingPlanned: vi.fn() }));
const viewing = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/lib/auth/impersonation", () => ({ refusedWhileViewingAs: async (what: string) => (viewing.value ? `${what} ${viewing.value}` : null) }));
const store = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => store.db!.client,
  createServiceClient: () => store.db!.client,
}));

const { mayStartSetupOver, stopSetupToChange } = await import("../onboarding-restart");
const { STOPPED_TO_CHANGE, TOO_LATE_TO_STOP } = await import("@/lib/onboarding/stop-to-change");

const EARLY = [
  { phase: "scanning", status: "done" },
  { phase: "keywords", status: "active" },
];

function seed(over: Record<string, unknown> = {}) {
  store.db = fakeDb({
    onboarding_runs: [
      { id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running", phases: EARLY, planned: [], article_id: null, updated_at: new Date().toISOString(), ...over },
    ],
  });
  return store.db;
}

beforeEach(() => {
  auth.role = "owner";
  viewing.value = null;
  canSpend.mockReset().mockResolvedValue({ allowed: true, reason: "free-allowance", message: null });
});

describe("mayStartSetupOver", () => {
  it("is yes for the owner of a live run when the gate would start one more setup run", async () => {
    seed();
    expect(await mayStartSetupOver("ws1", "r1")).toBe(true);
    expect(canSpend).toHaveBeenCalledWith(expect.anything(), "ag1", expect.objectContaining({ workspaceId: "ws1", action: "setup" }));
  });

  it("is no when this run is the account's last setup run before the trial", async () => {
    seed();
    canSpend.mockResolvedValue({ allowed: false, reason: "trial-required", message: "Setup has already run for this account." });
    expect(await mayStartSetupOver("ws1", "r1")).toBe(false);
  });

  it("is no for anyone but the owner, and while an operator is viewing as the account", async () => {
    seed();
    auth.role = "member";
    expect(await mayStartSetupOver("ws1", "r1")).toBe(false);
    auth.role = "owner";
    viewing.value = "is not run while viewing as the owner.";
    expect(await mayStartSetupOver("ws1", "r1")).toBe(false);
    expect(canSpend).not.toHaveBeenCalled();
  });

  it("is no for a run that has ended, or that is another site's", async () => {
    seed({ status: "done" });
    expect(await mayStartSetupOver("ws1", "r1")).toBe(false);
    seed();
    expect(await mayStartSetupOver("ws2", "r1")).toBe(false);
  });
});

describe("stopSetupToChange", () => {
  it("closes a run still finding searches, with its reason", async () => {
    const db = seed();
    expect(await stopSetupToChange("ws1", "r1")).toEqual({ ok: true });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: STOPPED_TO_CHANGE });
  });

  it("refuses with the gate's sentence, and leaves the run going, when no setup run would be left", async () => {
    const db = seed();
    canSpend.mockResolvedValue({ allowed: false, reason: "trial-required", message: "Setup has already run for this account." });
    expect(await stopSetupToChange("ws1", "r1")).toEqual({ ok: false, message: "Setup has already run for this account." });
    expect(db.tables.onboarding_runs[0].status).toBe("running");
  });

  it("refuses once the run has moved past finding searches", async () => {
    const db = seed({ phases: [{ phase: "scanning", status: "done" }, { phase: "keywords", status: "done" }, { phase: "planning", status: "active" }] });
    expect(await stopSetupToChange("ws1", "r1")).toEqual({ ok: false, message: TOO_LATE_TO_STOP });
    expect(db.tables.onboarding_runs[0].status).toBe("running");
  });
});
