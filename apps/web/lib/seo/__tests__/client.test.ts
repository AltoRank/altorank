import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
const { recordSpendByDefault } = vi.hoisted(() => ({ recordSpendByDefault: vi.fn() }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault }));

import { post, hasDataForSEOCredentials, DataForSEOError } from "../client";

// The shape below is copied from a real 40201 response observed on 2026-08-30
// when the altorank@supalabs.co account was suspended: the envelope says
// 20000 "Ok." while the single task inside carries the failure and a null
// result. Checking only the envelope turned that into a successful empty SERP.

const SUSPENDED = {
  version: "0.1.20260101",
  status_code: 20000,
  status_message: "Ok.",
  time: "0 sec.",
  cost: 0,
  tasks_count: 1,
  tasks_error: 1,
  tasks: [
    {
      id: "t1",
      status_code: 40201,
      status_message:
        "We noticed some unusual activity in your DataForSEO account, so we've temporarily paused access as a precaution.",
      time: "0 sec.",
      cost: 0,
      result_count: 0,
      path: ["v3", "serp", "google", "organic", "live", "advanced"],
      data: {},
      result: null,
    },
  ],
};

const OK = {
  ...SUSPENDED,
  tasks_error: 0,
  tasks: [
    { ...SUSPENDED.tasks[0], status_code: 20000, status_message: "Ok.", result: [{ items: [] }] },
  ],
};

function respond(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

beforeEach(() => {
  vi.stubEnv("DATAFORSEO_API_KEY", "dGVzdDp0ZXN0");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hasDataForSEOCredentials", () => {
  it("accepts the pre-encoded key on its own", () => {
    expect(hasDataForSEOCredentials()).toBe(true);
  });

  it("accepts a login/password pair", () => {
    vi.stubEnv("DATAFORSEO_API_KEY", "");
    vi.stubEnv("DATAFORSEO_LOGIN", "a@b.co");
    vi.stubEnv("DATAFORSEO_PASSWORD", "pw");
    expect(hasDataForSEOCredentials()).toBe(true);
  });

  it("is false when neither form is present", () => {
    vi.stubEnv("DATAFORSEO_API_KEY", "");
    vi.stubEnv("DATAFORSEO_LOGIN", "");
    vi.stubEnv("DATAFORSEO_PASSWORD", "");
    expect(hasDataForSEOCredentials()).toBe(false);
  });
});

const TRANSIENT = {
  ...SUSPENDED,
  tasks: [{ ...SUSPENDED.tasks[0], status_code: 40101, status_message: "Internal SE Server Error." }],
};

describe("post — retry on transient faults", () => {
  it("retries a 40101 and returns the success that follows", async () => {
    // Observed for real: the same keyword returned Ok / 40101 / Ok.
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      return new Response(JSON.stringify(n === 1 ? TRANSIENT : OK), { status: 200 });
    }));
    const r = await post("/x", [{}]);
    expect(r.tasks[0].status_code).toBe(20000);
    expect(n).toBe(2);
  });

  it("gives up after 3 attempts and throws", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(TRANSIENT), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await expect(post("/x", [{}])).rejects.toThrow(DataForSEOError);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a suspended account — that is permanent for this call", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(SUSPENDED), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await expect(post("/x", [{}])).rejects.toThrow(/temporarily paused/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 401", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", f);
    await expect(post("/x", [{}])).rejects.toThrow(DataForSEOError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("post — task-level failures", () => {
  it("throws when every task failed, even though the envelope says 20000 Ok.", async () => {
    respond(SUSPENDED);
    await expect(post("/serp/google/organic/live/advanced", [{}])).rejects.toThrow(
      DataForSEOError,
    );
  });

  it("surfaces the provider's own reason rather than a generic message", async () => {
    respond(SUSPENDED);
    await expect(post("/serp/google/organic/live/advanced", [{}])).rejects.toThrow(
      /temporarily paused access/,
    );
  });

  it("does not throw on a genuinely successful but empty result", async () => {
    // An empty SERP is a real answer. Only a failed task is an error.
    respond(OK);
    const r = await post("/serp/google/organic/live/advanced", [{}]);
    expect(r.tasks[0].status_code).toBe(20000);
  });

  it("still throws on an envelope-level failure", async () => {
    respond({ ...SUSPENDED, status_code: 40000, status_message: "Bad Request." });
    await expect(post("/x", [{}])).rejects.toThrow(DataForSEOError);
  });

  it("throws on a non-200 HTTP response", async () => {
    respond({}, 401);
    await expect(post("/x", [{}])).rejects.toThrow(DataForSEOError);
  });
});

describe("spend recording", () => {
  const ok = (cost: number) => ({
    ok: true,
    status: 200,
    json: async () => ({ status_code: 20000, status_message: "Ok.", cost, tasks: [{ status_code: 20000, result: [] }] }),
  }) as unknown as Response;

  it("accepts 20100 Task Created as a successful task", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status_code: 20000, cost: 0.0006, tasks: [{ id: "t", status_code: 20100, status_message: "Task Created.", result: null }] }),
    })) as unknown as typeof fetch);
    process.env.DATAFORSEO_API_KEY = "x";
    await expect(post("/serp/google/organic/task_post", [{}])).resolves.toMatchObject({ cost: 0.0006 });
  });

  it("records through the armed reporter when one is set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(0.0132)) as unknown as typeof fetch);
    process.env.DATAFORSEO_API_KEY = "x";
    const seen: unknown[] = [];
    const { setSpendReporter } = await import("../client");
    setSpendReporter((e) => { seen.push(e); });
    await post("/dataforseo_labs/google/ranked_keywords/live", [{}]);
    setSpendReporter(null);
    expect(seen).toEqual([{ operation: "/dataforseo_labs/google/ranked_keywords/live", costUsd: 0.0132 }]);
  });

  it("falls back to the default recorder when nothing is armed", async () => {
    recordSpendByDefault.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => ok(0.002)) as unknown as typeof fetch);
    process.env.DATAFORSEO_API_KEY = "x";
    await post("/serp/google/organic/live/regular", [{}]);
    // The default is loaded with a dynamic import, so it lands a tick or two
    // after the call returns; wait for it rather than guessing the tick.
    await vi.waitFor(() =>
      expect(recordSpendByDefault).toHaveBeenCalledWith({
        provider: "dataforseo",
        operation: "/serp/google/organic/live/regular",
        costUsd: 0.002,
      }),
    );
  });
});

describe("spendOperation", () => {
  it("folds the task id out of task_get so a night's collection is one operation", async () => {
    const { spendOperation } = await import("../client");
    expect(spendOperation("/serp/google/organic/task_get/regular/09022023-2413-0066-0000-1f6a6e02b1bb"))
      .toBe("/serp/google/organic/task_get/regular/{id}");
    expect(spendOperation("/serp/google/organic/task_post")).toBe("/serp/google/organic/task_post");
    expect(spendOperation("/dataforseo_labs/google/ranked_keywords/live")).toBe("/dataforseo_labs/google/ranked_keywords/live");
  });
});
