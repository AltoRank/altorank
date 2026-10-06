import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextUtcMidnight, releaseUserRun, reserveUserRun, runsLeftToday, userDailyRuns } from "../user-runs";

const rpcClient = (answer: { data: unknown; error: { message: string } | null } | Error) => ({
  rpc: vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  }),
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.PUBLIC_TOOLS_USER_DAILY_RUNS;
  vi.restoreAllMocks();
});

describe("userDailyRuns", () => {
  it("defaults to 3 and reads a whole number from the env", () => {
    expect(userDailyRuns()).toBe(3);
    process.env.PUBLIC_TOOLS_USER_DAILY_RUNS = "5";
    expect(userDailyRuns()).toBe(5);
    process.env.PUBLIC_TOOLS_USER_DAILY_RUNS = "0";
    expect(userDailyRuns()).toBe(0);
  });

  it.each(["-1", "2.5", "lots", " "])("ignores a nonsense value (%s)", (v) => {
    process.env.PUBLIC_TOOLS_USER_DAILY_RUNS = v;
    expect(userDailyRuns()).toBe(3);
  });
});

describe("nextUtcMidnight", () => {
  it("is the start of the next UTC day, across a month end", () => {
    expect(nextUtcMidnight(new Date("2026-09-30T23:10:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(nextUtcMidnight(new Date("2026-09-28T00:00:00Z")).toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });
});

describe("reserveUserRun", () => {
  it("passes the user and the configured limit, and reads the answer", async () => {
    process.env.PUBLIC_TOOLS_USER_DAILY_RUNS = "4";
    const c = rpcClient({ data: { ok: true, day: "2026-09-28", remaining: 3 }, error: null });
    await expect(reserveUserRun("u1", c)).resolves.toEqual({ ok: true, day: "2026-09-28", remaining: 3 });
    expect(c.rpc).toHaveBeenCalledWith("reserve_public_tool_user_run", { p_user_id: "u1", p_limit: 4 });
  });

  it("reports the cap", async () => {
    const c = rpcClient({ data: { ok: false, day: "2026-09-28", remaining: 0 }, error: null });
    await expect(reserveUserRun("u1", c)).resolves.toEqual({ ok: false, reason: "cap" });
  });

  it.each([
    ["no client", null],
    ["an RPC error (migration not applied)", rpcClient({ data: null, error: { message: "function does not exist" } })],
    ["a throw", rpcClient(new Error("network"))],
    ["an unexpected shape", rpcClient({ data: true, error: null })],
    ["ok without day", rpcClient({ data: { ok: true, remaining: 1 }, error: null })],
  ])("fails closed on %s", async (_label, c) => {
    await expect(reserveUserRun("u1", c)).resolves.toEqual({ ok: false, reason: "error" });
  });
});

describe("releaseUserRun", () => {
  it("gives back the run on the day it was taken", async () => {
    const c = rpcClient({ data: null, error: null });
    await releaseUserRun("u1", "2026-09-28", c);
    expect(c.rpc).toHaveBeenCalledWith("release_public_tool_user_run", { p_user_id: "u1", p_day: "2026-09-28" });
  });

  it("never throws", async () => {
    await expect(releaseUserRun("u1", "2026-09-28", rpcClient(new Error("down")))).resolves.toBeUndefined();
    await expect(releaseUserRun("u1", "2026-09-28", rpcClient({ data: null, error: { message: "x" } }))).resolves.toBeUndefined();
    await expect(releaseUserRun("u1", "2026-09-28", null)).resolves.toBeUndefined();
  });
});

describe("runsLeftToday", () => {
  const readClient = (row: { runs?: unknown } | null, error: { message: string } | null = null) => {
    const maybeSingle = vi.fn(async () => ({ data: row, error }));
    const eq2 = vi.fn(() => ({ maybeSingle }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const select = vi.fn(() => ({ eq: eq1 }));
    return { client: { from: vi.fn(() => ({ select })) }, eq1, eq2 };
  };

  it("is the limit minus today's runs, never negative", async () => {
    expect(await runsLeftToday("u1", readClient({ runs: 1 }).client)).toBe(2);
    expect(await runsLeftToday("u1", readClient({ runs: 7 }).client)).toBe(0);
    expect(await runsLeftToday("u1", readClient(null).client)).toBe(3);
  });

  it("is null, not a number nobody measured, when the read fails", async () => {
    expect(await runsLeftToday("u1", readClient(null, { message: "x" }).client)).toBeNull();
    expect(await runsLeftToday("u1", null)).toBeNull();
  });
});
