import { describe, expect, it, vi, beforeEach } from "vitest";

// One thenable that answers whatever the chain ends up asking for. The query in
// traffic.ts is built up with .select().eq().gte().order() and sometimes a
// second .eq(), then awaited, so every link returns itself.
let result: { data: unknown; error: unknown } = { data: [], error: null };

function chain() {
  const self: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "order"]) self[method] = vi.fn(() => self);
  self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return self;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => chain() }),
}));

const day = (agoDays: number) =>
  new Date(Date.now() - agoDays * 86_400_000).toISOString().slice(0, 10);

async function series() {
  const { getTrafficSeries } = await import("../traffic");
  return getTrafficSeries("11111111-1111-4111-8111-111111111111");
}

beforeEach(() => {
  result = { data: [], error: null };
});

describe("getTrafficSeries", () => {
  it("reports nothing measured when no rows have been synced", async () => {
    const s = await series();
    expect(s.hasData).toBe(false);
    expect(s.hasClicks).toBe(false);
    expect(s.impressions).toBe(0);
  });

  it("treats a failed query as unmeasured rather than as zero traffic", async () => {
    result = { data: null, error: { message: "boom" } };
    const s = await series();
    expect(s.hasData).toBe(false);
    expect(s.hasClicks).toBe(false);
  });

  it("separates a measured zero from nothing measured", async () => {
    // The state a new domain is actually in: Google is showing the pages and
    // nobody has clicked. This used to render a flat line at zero, which is a
    // claim about the site rather than about the data, and the dashboard's own
    // explanation for it could never run because impressions were dropped.
    result = {
      data: [
        { metric_date: day(2), clicks: 0, impressions: 300 },
        { metric_date: day(2), clicks: 0, impressions: 159 },
        { metric_date: day(1), clicks: 0, impressions: 300 },
      ],
      error: null,
    };
    const s = await series();
    expect(s.hasData).toBe(true);
    expect(s.hasClicks).toBe(false);
    expect(s.impressions).toBe(759);
    expect(s.currentTotal).toBe(0);
    // No baseline and no clicks: a percentage here would describe nothing.
    expect(s.changePct).toBeNull();
  });

  it("sums same-day rows and counts clicks in the current window", async () => {
    result = {
      data: [
        { metric_date: day(1), clicks: 4, impressions: 100 },
        { metric_date: day(1), clicks: 6, impressions: 120 },
        { metric_date: day(3), clicks: 2, impressions: 40 },
      ],
      error: null,
    };
    const s = await series();
    expect(s.hasData).toBe(true);
    expect(s.hasClicks).toBe(true);
    expect(s.currentTotal).toBe(12);
    expect(s.impressions).toBe(260);
    expect(s.current).toHaveLength(s.days);
    expect(s.previous).toHaveLength(s.days);
  });

  it("knows whether the comparison window was synced at all", async () => {
    // A week of backfill after connecting: the current window has rows, the
    // previous one has none. Drawing a dashed line from it would claim last
    // month had zero clicks; the flag lets the chart leave it out instead.
    result = { data: [{ metric_date: day(2), clicks: 3, impressions: 30 }], error: null };
    expect((await series()).previousMeasured).toBe(false);
    result = { data: [{ metric_date: day(2), clicks: 3, impressions: 30 }, { metric_date: day(40), clicks: 0, impressions: 10 }], error: null };
    expect((await series()).previousMeasured).toBe(true);
  });

  it("counts clicks that fall only in the previous window", async () => {
    // 45 days ago is outside the current 30 but inside the comparison window,
    // so there are clicks to plot even though the current total is zero.
    result = { data: [{ metric_date: day(45), clicks: 5, impressions: 50 }], error: null };
    const s = await series();
    expect(s.hasClicks).toBe(true);
    expect(s.currentTotal).toBe(0);
    expect(s.previousTotal).toBe(5);
  });

  it("treats a null impression count as zero rather than as NaN", async () => {
    result = { data: [{ metric_date: day(1), clicks: 0, impressions: null }], error: null };
    const s = await series();
    expect(s.impressions).toBe(0);
    expect(s.hasClicks).toBe(false);
  });
});
