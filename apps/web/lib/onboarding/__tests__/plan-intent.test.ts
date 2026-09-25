import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The planner's own duplicate check: an entry that stays on the calendar owns
 * its search, so a phrasing of it is not planned beside it. A real signup
 * (2026-09-22) had one Turkish search drafted, queued and held under three
 * spellings; "şirket" and "firma" are synonyms that only the results page
 * sees, so a kept entry is compared by its keyword row's results page.
 */

const { recommend } = vi.hoisted(() => ({ recommend: vi.fn() }));
vi.mock("@/lib/seo/recommendations", async (original) => ({ ...await original<object>(), recommendKeywords: (...a: unknown[]) => recommend(...a) }));

import { previewPlan } from "../plan";

const page = (prefix: string, n = 10) => Array.from({ length: n }, (_, i) => `https://${prefix}-${i}.example/sayfa`);
const serp = (base: string[], shared: number, prefix: string) => [...base.slice(0, shared), ...page(prefix, 10 - shared)];
const OWNER = page("owner");

type Entry = { keyword_id: string | null; keyword: string | null; scheduled_date: string; article_id: string | null; status: "queue" | "scheduled" };
let calendar: Entry[] = [];
let keywordRows: Array<{ id: string; opportunity: unknown }> = [];

function client(language = "tr"): SupabaseClient {
  return {
    from(table: string) {
      let columns = "";
      const q: Record<string, unknown> = {};
      q.select = (c: string) => { columns = c; return q; };
      for (const m of ["eq", "in", "is", "not", "order"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: table === "workspaces" ? { language } : null, error: null });
      q.then = (resolve: (v: unknown) => unknown) => resolve({
        data: table === "calendar_entries" ? calendar
          : table === "keywords" ? (columns.includes("opportunity") ? keywordRows : [])
            : [],
        error: null,
      });
      return q;
    },
  } as unknown as SupabaseClient;
}

const rec = (keywordId: string, term: string, organicUrls: string[] | null) =>
  ({ keywordId, term, action: "write", quality: "ok", intent: "commercial", opportunity: organicUrls ? { status: "qualified", organicUrls } : undefined });

beforeEach(() => {
  recommend.mockReset();
  calendar = [];
  keywordRows = [];
});

describe("planFor: an entry kept on the calendar owns its search", () => {
  it("compares a kept entry by its keyword row's results page, so a synonym is not planned beside it", async () => {
    calendar = [{ keyword_id: "q", keyword: "mobil uygulama geliştirme şirketleri", scheduled_date: "2026-09-26", article_id: null, status: "scheduled" }];
    keywordRows = [{ id: "q", opportunity: { status: "qualified", organicUrls: OWNER } }];
    recommend.mockResolvedValue([
      rec("h", "mobil uygulama geliştirme firması", serp(OWNER, 5, "h")),
      rec("o", "kurumsal web tasarım fiyatları", page("o")),
    ]);
    const { next } = await previewPlan(client(), "ws", 7, { from: new Date("2026-09-25T00:00:00Z") });
    expect(next.map((p) => p.keywordId)).toEqual(["o"]);
  });

  it("reads the calendar after the recommender, which can take a phrasing nobody will write off it", async () => {
    // "seo agencies" is on the calendar but refused; the recommender parks it
    // and removes its entry, and "agency seo" now leads the search. Read
    // before, the stale entry would have kept "agency seo" off the plan.
    calendar = [{ keyword_id: "p", keyword: "seo agencies", scheduled_date: "2026-09-26", article_id: null, status: "scheduled" }];
    recommend.mockImplementation(async () => {
      calendar = [];
      return [rec("c", "agency seo", null)];
    });
    const { next } = await previewPlan(client("en"), "ws", 7, { from: new Date("2026-09-25T00:00:00Z") });
    expect(next.map((p) => p.keywordId)).toEqual(["c"]);
  });

  it("does not run the recommender, which can spend, when the calendar is already full", async () => {
    calendar = Array.from({ length: 60 }, (_, i) => ({ keyword_id: `k${i}`, keyword: `term ${i}`, scheduled_date: "2026-10-01", article_id: null, status: "scheduled" as const }));
    const { next } = await previewPlan(client("en"), "ws", 7);
    expect(next).toEqual([]);
    expect(recommend).not.toHaveBeenCalled();
  });
});
