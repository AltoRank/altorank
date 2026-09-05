import { describe, expect, it } from "vitest";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import { bulkRemove, bulkReschedule, shiftIsoDate } from "../entries";

const WS = "ws-1";
const OTHER = "ws-2";

function seed() {
  return fakeSupabase({
    keywords: [
      { id: "k-planned", workspace_id: WS, term: "planned one", status: "planned", plan_excluded_at: null },
      { id: "k-written", workspace_id: WS, term: "written", status: "drafting", plan_excluded_at: null },
      { id: "k-loose", workspace_id: WS, term: "not planned", status: "new", plan_excluded_at: null },
      { id: "k-other", workspace_id: OTHER, term: "someone else's", status: "planned", plan_excluded_at: null },
    ],
    calendar_entries: [
      { id: "e-planned", workspace_id: WS, keyword_id: "k-planned", keyword: "planned one", article_id: null, scheduled_date: "2026-10-01", status: "queue" },
      { id: "e-written", workspace_id: WS, keyword_id: "k-written", keyword: "written", article_id: "a-1", scheduled_date: "2026-09-20", status: "scheduled" },
      { id: "e-other", workspace_id: OTHER, keyword_id: "k-other", keyword: "someone else's", article_id: null, scheduled_date: "2026-10-01", status: "queue" },
    ],
  });
}

describe("bulkRemove", () => {
  it("deletes the entry and stamps the keyword excluded; the keyword row itself stays", async () => {
    const db = seed();
    const out = await bulkRemove(db as never, WS, ["k-planned"]);
    expect(out).toEqual([{ keyword_id: "k-planned", entry_id: "e-planned", ok: true }]);
    expect(db.tables.calendar_entries.find((e) => e.id === "e-planned")).toBeUndefined();
    const kw = db.tables.keywords.find((k) => k.id === "k-planned")!;
    expect(kw.plan_excluded_at).toBeTruthy();
    expect(db.writes.filter((w) => w.table === "keywords" && w.op === "delete")).toHaveLength(0);
  });

  it("skips a written entry and a keyword that is not on the plan, saying why", async () => {
    const db = seed();
    const out = await bulkRemove(db as never, WS, ["k-written", "k-loose"]);
    expect(out.map((o) => o.ok)).toEqual([false, false]);
    expect(out[0].reason).toMatch(/already written/i);
    expect(out[1].reason).toMatch(/not on the plan/i);
    expect(db.writes).toHaveLength(0);
  });

  it("cannot reach another workspace's entry through its keyword id", async () => {
    const db = seed();
    const out = await bulkRemove(db as never, WS, ["k-other"]);
    expect(out[0]).toMatchObject({ ok: false, reason: "Not on the plan." });
    expect(db.tables.calendar_entries.find((e) => e.id === "e-other")).toBeTruthy();
  });
});

describe("bulkReschedule", () => {
  it("moves each keyword to its own day", async () => {
    const db = seed();
    const out = await bulkReschedule(db as never, WS, { items: [{ keyword_id: "k-planned", date: "2026-10-15" }] });
    expect(out[0]).toMatchObject({ ok: true, from: "2026-10-01", to: "2026-10-15" });
    expect(db.tables.calendar_entries.find((e) => e.id === "e-planned")!.scheduled_date).toBe("2026-10-15");
  });

  it("shifts by days, negative included", async () => {
    const db = seed();
    const out = await bulkReschedule(db as never, WS, { keyword_ids: ["k-planned"], shift_days: -3 });
    expect(out[0]).toMatchObject({ ok: true, to: "2026-09-28" });
  });

  it("refuses a written entry and a bad date without touching anything", async () => {
    const db = seed();
    const out = await bulkReschedule(db as never, WS, {
      items: [
        { keyword_id: "k-written", date: "2026-10-15" },
        { keyword_id: "k-planned", date: "not-a-date" },
      ],
    });
    expect(out[0]).toMatchObject({ ok: false });
    expect(out[0].reason).toMatch(/already written/i);
    expect(out[1]).toMatchObject({ ok: false });
    expect(out[1].reason).toMatch(/valid date/i);
    expect(db.writes).toHaveLength(0);
  });
});

describe("shiftIsoDate", () => {
  it("crosses month and year boundaries", () => {
    expect(shiftIsoDate("2026-12-30", 3)).toBe("2027-01-02");
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
  });
});
