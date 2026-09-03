import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  orderByStaleness,
  latestPerWorkspace,
  MAX_ARTICLES_PER_RUN,
  OBSERVED_SECONDS_PER_ARTICLE,
  RUN_BUDGET_SECONDS,
} from "./generate-queue";

describe("latestPerWorkspace", () => {
  it("keeps the newest row per workspace when rows arrive newest first", () => {
    const latest = latestPerWorkspace([
      { workspace_id: "a", created_at: "2026-09-03T09:00:00Z" },
      { workspace_id: "b", created_at: "2026-09-03T08:00:00Z" },
      { workspace_id: "a", created_at: "2026-09-01T09:00:00Z" },
    ]);
    expect(latest.get("a")).toBe("2026-09-03T09:00:00Z");
    expect(latest.get("b")).toBe("2026-09-03T08:00:00Z");
  });

  it("has no entry for a workspace with nothing in the window", () => {
    expect(latestPerWorkspace([]).has("a")).toBe(false);
  });
});

describe("orderByStaleness", () => {
  const ws = (id: string) => ({ id });

  it("puts never-written workspaces before written ones", () => {
    const ordered = orderByStaleness(
      [ws("written"), ws("never")],
      new Map([["written", "2026-09-03T09:00:00Z"]]),
    );
    expect(ordered.map((w) => w.id)).toEqual(["never", "written"]);
  });

  it("orders written workspaces oldest draft first", () => {
    const ordered = orderByStaleness([ws("new"), ws("old"), ws("mid")], new Map([
      ["new", "2026-09-03T09:00:00Z"],
      ["mid", "2026-09-02T09:00:00Z"],
      ["old", "2026-08-30T09:00:00Z"],
    ]));
    expect(ordered.map((w) => w.id)).toEqual(["old", "mid", "new"]);
  });

  it("does not mutate the input", () => {
    const input = [ws("b"), ws("a")];
    orderByStaleness(input, new Map([["b", "2026-09-03T09:00:00Z"]]));
    expect(input.map((w) => w.id)).toEqual(["b", "a"]);
  });

  /**
   * The reason the ordering exists. Three workspaces, a cap of two, and the
   * one starved by the first run must lead the second - otherwise the cap is
   * a queue nobody advances in.
   */
  it("rotates under a cap instead of serving the same workspaces twice", () => {
    const all = [ws("a"), ws("b"), ws("c")];
    const CAP = 2;

    const written = new Map<string, string>();
    const serve = (at: string) => {
      const served = orderByStaleness(all, written).slice(0, CAP);
      for (const w of served) written.set(w.id, at);
      return served.map((w) => w.id);
    };

    const first = serve("2026-09-03T01:00:00Z");
    const second = serve("2026-09-03T07:00:00Z");

    expect(first).toHaveLength(2);
    // Whoever the first run left out is served by the second.
    const starved = all.map((w) => w.id).find((id) => !first.includes(id))!;
    expect(second).toContain(starved);
    // And across two runs every workspace has been written at least once.
    expect(new Set([...first, ...second])).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("MAX_ARTICLES_PER_RUN", () => {
  it("fits inside the function's budget at the measured cost of a draft", () => {
    // The guard this file exists for. The cap was 3 on an estimate; the first
    // production run measured a draft at 103 seconds, which makes 3 about 310
    // against a 300-second function. Raising the cap without also raising
    // maxDuration or making a draft cheaper should fail here rather than time
    // out mid-write and leave a row stuck in `drafting`.
    expect(MAX_ARTICLES_PER_RUN * OBSERVED_SECONDS_PER_ARTICLE).toBeLessThan(RUN_BUDGET_SECONDS);
  });

  it("leaves enough headroom for a draft that runs slower than the average", () => {
    // 103s is one sample. A cap that only just fits would overrun on any draft
    // above the mean, so require room for a 40% slower one.
    const slowest = OBSERVED_SECONDS_PER_ARTICLE * 1.4;
    expect(MAX_ARTICLES_PER_RUN * slowest).toBeLessThan(RUN_BUDGET_SECONDS);
  });

  it("agrees with the maxDuration the route actually declares", () => {
    // The one place this budget is duplicated, because Next reads segment
    // config statically and will not take an imported constant. Reading the
    // literal keeps the "keep in step" comment enforceable.
    const route = readFileSync(
      new URL("../../app/api/cron/generate/route.ts", import.meta.url),
      "utf8",
    );
    const declared = route.match(/export const maxDuration = (\d+)/)?.[1];
    expect(declared).toBeDefined();
    expect(Number(declared)).toBe(RUN_BUDGET_SECONDS);
  });

  it("still writes more than one article per run", () => {
    // Four runs a day at one each would be 4 a day, under the 100 a month the
    // plan sells once several sites share the schedule.
    expect(MAX_ARTICLES_PER_RUN).toBeGreaterThan(1);
  });
});
