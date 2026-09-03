import { describe, it, expect } from "vitest";
import { orderByStaleness, latestPerWorkspace } from "./generate-queue";

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
