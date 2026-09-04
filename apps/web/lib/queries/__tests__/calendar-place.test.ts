import { describe, it, expect, vi, beforeEach } from "vitest";

const rows: Record<string, unknown>[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    // Articles come from `rows`; the planned-keyword query (calendar_entries)
    // is empty here, since these tests are about deriving entries from articles.
    from: (table: string) => {
      const data = table === "articles" ? rows : [];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        is: () => q,
        in: () => q,
        then: (r: (v: { data: unknown; error: null }) => unknown) => r({ data, error: null }),
      };
      return q;
    },
  }),
}));

import { getCalendarEntries } from "../calendar";

const article = (o: Partial<Record<string, unknown>> = {}) => ({
  id: "a1", workspace_id: "w1", keyword: "seo content", title: "T",
  status: "review", scheduled_at: null, published_at: null,
  created_at: "2026-09-10T09:00:00Z", ...o,
});

beforeEach(() => { rows.length = 0; });

describe("calendar entries, derived from articles", () => {
  it("dates a live article by when it published", async () => {
    rows.push(article({ status: "live", published_at: "2026-09-05T08:00:00Z" }));
    const [e] = await getCalendarEntries();
    expect(e.status).toBe("done");
    expect(e.scheduled_date).toBe("2026-09-05T08:00:00Z");
  });

  it("keeps a live article that predates published_at rather than dropping it", async () => {
    rows.push(article({ status: "live", published_at: null }));
    const [e] = await getCalendarEntries();
    expect(e.status).toBe("done");
    expect(e.scheduled_date).toBe("2026-09-10T09:00:00Z");
  });

  it("puts a scheduled article on its scheduled day", async () => {
    rows.push(article({ status: "scheduled", scheduled_at: "2026-09-20T07:00:00Z" }));
    const [e] = await getCalendarEntries();
    expect(e).toMatchObject({ status: "scheduled", scheduled_date: "2026-09-20T07:00:00Z" });
  });

  it("shows what is being written now as running", async () => {
    rows.push(article({ status: "drafting" }));
    expect((await getCalendarEntries())[0].status).toBe("run");
  });

  it("omits states that are not calendar events", async () => {
    // A draft in review has no date it belongs on. Placing it anyway would
    // invent a commitment nobody made.
    rows.push(article({ status: "review" }), article({ id: "a2", status: "draft" }));
    expect(await getCalendarEntries()).toEqual([]);
  });

  it("filters by month against whichever column dated the entry", async () => {
    rows.push(
      article({ id: "in", status: "scheduled", scheduled_at: "2026-09-20T07:00:00Z" }),
      article({ id: "out", status: "scheduled", scheduled_at: "2026-10-02T07:00:00Z" }),
    );
    const got = await getCalendarEntries(undefined, "2026-09");
    expect(got.map((e) => e.id)).toEqual(["in"]);
  });

  it("falls back to the title so a hand-written article is not a blank chip", async () => {
    rows.push(article({ status: "live", keyword: null, title: "Written by hand" }));
    expect((await getCalendarEntries())[0].keyword).toBe("Written by hand");
  });

  it("returns entries in date order", async () => {
    rows.push(
      article({ id: "late", status: "scheduled", scheduled_at: "2026-09-28T07:00:00Z" }),
      article({ id: "early", status: "scheduled", scheduled_at: "2026-09-02T07:00:00Z" }),
    );
    expect((await getCalendarEntries()).map((e) => e.id)).toEqual(["early", "late"]);
  });
});
