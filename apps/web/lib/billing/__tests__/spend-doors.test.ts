import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  doorLimits,
  doorRefusal,
  inputKey,
  keepDoorResult,
  readDoorCache,
  resetDoorMemory,
  takeDoor,
  DOOR_LIMITS,
} from "../spend-doors";

// ---------------------------------------------------------------------------
// Counting presses of a paid door
// ---------------------------------------------------------------------------
//
// The database counts (migration 116's take_spend_door, checked in
// supabase/tests/116_spend_doors.rls.sql). Here: what the app sends it, how it
// reads the answer, and that without 116 the same limits hold in memory.

beforeEach(() => resetDoorMemory());

describe("takeDoor without the database", () => {
  it("allows up to the hourly limit for an account, then refuses with the limit named", async () => {
    const now = () => 1_000_000;
    const hourly = DOOR_LIMITS["editor-rewrite"][0].limit;
    for (let i = 0; i < hourly; i++) {
      expect((await takeDoor("editor-rewrite", { accountId: "acc-a" }, {}, { db: null, now })).allowed).toBe(true);
    }
    const refused = await takeDoor("editor-rewrite", { accountId: "acc-a" }, {}, { db: null, now });
    expect(refused).toMatchObject({ allowed: false, message: expect.stringContaining(`${hourly} an hour`) });
    // Another account is counted apart.
    expect((await takeDoor("editor-rewrite", { accountId: "acc-b" }, {}, { db: null, now })).allowed).toBe(true);
  });

  it("frees the window after an hour, but keeps the daily count", async () => {
    let t = 0;
    const now = () => t;
    const [hour, day] = DOOR_LIMITS["editor-rewrite"];
    let taken = 0;
    while (taken < day.limit) {
      for (let i = 0; i < hour.limit && taken < day.limit; i++, taken++) {
        expect((await takeDoor("editor-rewrite", { accountId: "acc-a" }, {}, { db: null, now })).allowed).toBe(true);
      }
      t += 3_601_000;
    }
    const refused = await takeDoor("editor-rewrite", { accountId: "acc-a" }, {}, { db: null, now });
    expect(refused).toMatchObject({ allowed: false, limit: day });
  });

  it("counts a wizard read per site, and before the trial for the account's whole life", async () => {
    const now = () => 0;
    const perSite = DOOR_LIMITS["wizard-site-read"][0].limit;
    for (let i = 0; i < perSite; i++) {
      expect((await takeDoor("wizard-site-read", { accountId: "acc", workspaceId: "ws-1" }, { preTrial: true }, { db: null, now })).allowed).toBe(true);
    }
    expect((await takeDoor("wizard-site-read", { accountId: "acc", workspaceId: "ws-1" }, { preTrial: true }, { db: null, now })).allowed).toBe(false);
    // A second site starts its own count, until the account's lifetime one.
    const lifetime = doorLimits("wizard-site-read", { preTrial: true }).find((l) => l.windowSeconds === null)!;
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if ((await takeDoor("wizard-site-read", { accountId: "acc", workspaceId: `ws-${i + 2}` }, { preTrial: true }, { db: null, now })).allowed) allowed++;
    }
    expect(perSite + allowed).toBe(lifetime.limit);
  });
});

describe("takeDoor with the database", () => {
  function db(answer: { data?: unknown; error?: { message: string } | null }) {
    const rpc = vi.fn(async () => ({ data: answer.data ?? null, error: answer.error ?? null }));
    return { rpc, client: { rpc } as unknown as SupabaseClient };
  }

  it("asks take_spend_door with the door's limits and keeps the use id", async () => {
    const { rpc, client } = db({ data: [{ use_id: "use-1", refused_index: null }] });
    const took = await takeDoor("wizard-rivals", { accountId: "acc", workspaceId: "ws" }, { preTrial: true }, { db: client });
    expect(took).toEqual({ allowed: true, useId: "use-1" });
    expect(rpc).toHaveBeenCalledWith("take_spend_door", {
      p_account: "acc",
      p_workspace: "ws",
      p_door: "wizard-rivals",
      p_limits: doorLimits("wizard-rivals", { preTrial: true }).map((l) => ({ scope: l.scope, limit: l.limit, seconds: l.windowSeconds })),
    });
  });

  it("names the limit the database refused on", async () => {
    const { client } = db({ data: [{ use_id: null, refused_index: 1 }] });
    const took = await takeDoor("editor-rewrite", { accountId: "acc" }, {}, { db: client });
    expect(took).toEqual({ allowed: false, limit: DOOR_LIMITS["editor-rewrite"][1], message: doorRefusal("editor-rewrite", DOOR_LIMITS["editor-rewrite"][1]) });
  });

  it("counts in memory when the function is not there yet", async () => {
    const { client } = db({ error: { message: "Could not find the function public.take_spend_door" } });
    const hourly = DOOR_LIMITS["editor-rewrite"][0].limit;
    const results = [];
    for (let i = 0; i <= hourly; i++) results.push((await takeDoor("editor-rewrite", { accountId: "acc" }, {}, { db: client, now: () => 0 })).allowed);
    expect(results.filter(Boolean)).toHaveLength(hourly);
    expect(results.at(-1)).toBe(false);
  });
});

describe("the wizard's kept reads", () => {
  it("hands back what a press bought for the same input, inside the window", async () => {
    let t = 0;
    const deps = { db: null, now: () => t };
    expect(await readDoorCache("wizard-site-read", "ws", "k", 60, deps)).toBeNull();
    await keepDoorResult("wizard-site-read", "ws", "k", null, { profile: { name: "Acme" } }, deps);
    expect(await readDoorCache("wizard-site-read", "ws", "k", 60, deps)).toEqual({ profile: { name: "Acme" } });
    expect(await readDoorCache("wizard-site-read", "ws", "other", 60, deps)).toBeNull();
    expect(await readDoorCache("wizard-site-read", "ws-2", "k", 60, deps)).toBeNull();
    t += 61_000;
    expect(await readDoorCache("wizard-site-read", "ws", "k", 60, deps)).toBeNull();
  });

  it("writes the result onto the counted use and reads it back from there", async () => {
    const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "gte", "order", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = async () => ({ data: { result: { from: "db" } }, error: null });
    const client = { from: vi.fn(() => ({ ...chain, update })) } as unknown as SupabaseClient;
    await keepDoorResult("wizard-rivals", "ws", "k", "use-1", { a: 1 }, { db: client });
    expect(update).toHaveBeenCalledWith({ cache_key: "k", result: { a: 1 } });
    expect(await readDoorCache("wizard-rivals", "ws", "k", 60, { db: client })).toEqual({ from: "db" });
  });
});

describe("inputKey", () => {
  it("is the same for the same input in any key order, and differs otherwise", () => {
    expect(inputKey({ a: 1, b: [1, { c: 2 }] })).toBe(inputKey({ b: [1, { c: 2 }], a: 1 }));
    expect(inputKey({ a: 1 })).not.toBe(inputKey({ a: 2 }));
    expect(inputKey({ a: 1, gone: undefined })).toBe(inputKey({ a: 1 }));
  });
});
