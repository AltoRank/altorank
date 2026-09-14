import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb, type FakeDb } from "./fake-runs-client";

let db: FakeDb;
const pipeline = vi.fn();
vi.mock("../worker-client", () => ({ createWorkerClient: () => db.client }));
vi.mock("../pipeline", () => ({ runOnboarding: (...args: unknown[]) => pipeline(...args) }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: vi.fn() }));
vi.mock("@/lib/email/lifecycle", () => ({ notifySetupFailed: vi.fn() }));
vi.mock("@/lib/email/draft-batch", () => ({ announceDraftBatch: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db.client }));
vi.mock("next/server", async () => ({
  ...await vi.importActual<typeof import("next/server")>("next/server"),
  after: (callback: () => unknown) => { void callback(); },
}));

import { executeRun } from "../run-worker";
import { dispatchWorker } from "../run-dispatch";
import { POST } from "@/app/api/onboard/run/route";

/** The real fake database still applies the other queries, and optionally the
 * uncertain claim itself, before this one response is lost in transport. */
function failPreflight(stage: "run" | "claim" | "workspace", mode: "response" | "throw", claimApplied = false) {
  const originalFrom = db.client.from.bind(db.client);
  let injected = false;
  vi.spyOn(db.client, "from").mockImplementation((table: string) => {
    const query = originalFrom(table);
    let update = false;
    const proxy = new Proxy(query, {
      get(target, property) {
        const method = Reflect.get(target, property);
        if (property === "then") return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
          const matches = stage === "workspace" ? table === "workspaces"
            : table === "onboarding_runs" && update === (stage === "claim");
          if (matches && !injected) {
            injected = true;
            return Promise.resolve().then(async () => {
              if (claimApplied) await Reflect.apply(method, target, [(value: unknown) => value]);
              if (mode === "throw") throw new DOMException("Database deadline reached", "TimeoutError");
              return { data: null, error: { message: "Database deadline reached" } };
            }).then(resolve, reject);
          }
          return Reflect.apply(method, target, [resolve, reject]);
        };
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          if (property === "update") update = true;
          const result = Reflect.apply(method, target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  });
}

const request = () => new NextRequest("http://localhost/api/onboard/run", {
  method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "test-secret" },
  body: JSON.stringify({ runId: "r1" }),
});

beforeEach(() => {
  vi.restoreAllMocks();
  pipeline.mockReset();
  process.env.CRON_SECRET = "test-secret";
  db = fakeDb({
    onboarding_runs: [{ id: "r1", workspace_id: "ws1", account_id: "a1", status: "running", phases: [], planned: [] }],
    workspaces: [{ id: "ws1", account_id: "a1", domain: "example.com" }],
  });
});

describe("onboarding preflight database errors", () => {
  it.each(["response", "throw"] as const)("returns a retryable response when the run read fails through %s", async (mode) => {
    failPreflight("run", mode);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ outcome: "retryable-error" });
    expect(db.updates).toEqual([]);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it.each([
    ["response", false], ["response", true], ["throw", false], ["throw", true],
  ] as const)("does not close a run when the claim fails through %s (committed: %s)", async (mode, claimApplied) => {
    failPreflight("claim", mode, claimApplied);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ outcome: "retryable-error" });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "running" });
    expect(db.updates.some(({ patch }) => patch.status === "error")).toBe(false);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it.each(["response", "throw"] as const)("reports a failed workspace read accurately after acquiring our claim (%s)", async (mode) => {
    failPreflight("workspace", mode);
    const result = await executeRun("r1", { supabase: db.client });
    expect(result.outcome).toBe("failed");
    expect(db.tables.onboarding_runs[0]).toMatchObject({
      status: "error", error: "Your workspace could not be loaded. Retry research in a moment.",
    });
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("preserves a potentially live run when dispatch receives the worker's retryable response", async () => {
    failPreflight("claim", "response", true);
    await dispatchWorker("r1", {
      supabase: db.client, baseUrl: "http://localhost", secret: "test-secret",
      fetchImpl: async () => POST(request()),
    });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "running", phases: [{ phase: "scanning", status: "pending" }] });
    expect(db.updates.some(({ patch }) => patch.status === "error")).toBe(false);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("a retry can claim an unstarted run after a transient read failure", async () => {
    failPreflight("run", "response");
    expect((await POST(request())).status).toBe(503);
    pipeline.mockImplementation(async (_client, _workspace, emit) => {
      emit({ phase: "scanning", status: "done" });
      return { pendingDraft: null, fanOutSettled: Promise.resolve() };
    });
    const retried = await POST(request());
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ outcome: "ran" });
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("continues to close a run when dispatch is refused for a non-retryable reason", async () => {
    await dispatchWorker("r1", {
      supabase: db.client, baseUrl: "http://localhost", secret: "test-secret",
      fetchImpl: async () => new Response("Unauthorized", { status: 401 }),
    });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: "The run could not be started (401)." });
  });

  it("keeps real missing and claimed rows distinct from transport errors", async () => {
    db.tables.onboarding_runs = [];
    expect((await POST(request())).status).toBe(404);
    db.tables.onboarding_runs = [{ id: "r1", workspace_id: "ws1", status: "running", phases: [{ phase: "scanning", status: "pending" }] }];
    expect((await POST(request())).status).toBe(409);
    expect(db.tables.onboarding_runs[0].status).toBe("running");
  });
});
