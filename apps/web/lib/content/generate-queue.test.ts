import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  orderByStaleness,
  latestPerWorkspace,
  MAX_ARTICLES_PER_RUN,
  OBSERVED_SECONDS_PER_ARTICLE,
  roomForAnother,
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
  it("one draft fits inside the function's budget at the measured cost", () => {
    // The guard this file exists for, in its current shape. The cap was 3 on
    // an estimate, then 2 on a 103-second measurement; on 2026-09-09 a draft
    // measured 209 seconds and the second of a run was killed under the
    // 300-second wall. So the count is a ceiling and `roomForAnother` - the
    // clock - is the bound. A draft that no longer fits at all should fail here
    // rather than time out on every run.
    expect(OBSERVED_SECONDS_PER_ARTICLE).toBeLessThan(RUN_BUDGET_SECONDS);
  });

  it("the clock refuses a second draft the budget cannot hold", () => {
    // Exactly the run that was killed: 209s spent, last draft 209s.
    expect(roomForAnother(OBSERVED_SECONDS_PER_ARTICLE * 1000, OBSERVED_SECONDS_PER_ARTICLE * 1000)).toBe(false);
  });

  it("leaves headroom for a draft that runs slower than the observation", () => {
    // The reserve carries a 20% margin over the slower of last-draft and
    // observation, so a run never starts a draft it can only just fit.
    const budget = RUN_BUDGET_SECONDS * 1000;
    const reserve = OBSERVED_SECONDS_PER_ARTICLE * 1000 * 1.2;
    expect(roomForAnother(budget - reserve + 1, null)).toBe(false);
    expect(roomForAnother(budget - reserve, null)).toBe(true);
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

  it("still allows more than one article per run when the clock permits", () => {
    // The count is a ceiling, not a promise: at today's 209s a run writes one
    // and the clock refuses a second. Throughput beyond that is fan-out's job
    // (lib/content/fan-out.ts), which is why a week of drafts is seven
    // invocations rather than one bigger number here.
    expect(MAX_ARTICLES_PER_RUN).toBeGreaterThan(1);
  });
});
