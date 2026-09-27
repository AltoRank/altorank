import { describe, expect, it } from "vitest";
import { heldTopics } from "../plan";
import { stateFromRun } from "../events";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = { id: string; term: string; status?: string; opportunity?: unknown };
/** A client that answers the held-row read, the owners read and the workspace's language. */
function client(held: Row[] | number, owners: { keywords?: Row[]; articles?: unknown[]; pages?: unknown[] } = {}, language = "tr"): SupabaseClient {
  const heldRows = typeof held === "number" ? Array.from({ length: held }, (_, i) => ({ id: `h${i}`, term: `held topic ${i}`, opportunity: { status: "qualified" } })) : held;
  return {
    from(table: string) {
      const filters: string[] = [];
      const data = () =>
        table === "keywords" ? (filters.includes("in") ? owners.keywords ?? [] : heldRows)
          : table === "articles" ? owners.articles ?? []
            : table === "site_pages" ? owners.pages ?? [] : [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "not", "order", "range"]) q[m] = () => { filters.push(m); return q; };
      q.maybeSingle = async () => ({ data: table === "workspaces" ? { language } : null, error: null });
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: data(), error: null });
      return q;
    },
  } as unknown as SupabaseClient;
}

const page = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `https://${prefix}${i}.example/sayfa`);
/** Ten results; the first `shared` of them are also on `base`. */
const serp = (base: string[], shared: number, prefix: string) => [...base.slice(0, shared), ...page(prefix, 10 - shared)];
const DRAFTED = page("owner", 10);

describe("heldTopics", () => {
  it("counts the qualified topics the plan left out and places them on the pace grid after the plan", async () => {
    const out = await heldTopics(client(3), "ws", 3, ["2026-09-21"], new Date("2026-09-21T00:00:00Z"));
    expect(out.count).toBe(3);
    expect(out.dates).toHaveLength(3);
    expect(out.dates[0] > "2026-09-21").toBe(true);
    expect(new Set(out.dates).size).toBe(3);
  });
  it("is empty when nothing is held", async () => {
    expect(await heldTopics(client(0), "ws", 3, [])).toEqual({ count: 0, dates: [] });
  });
  it("never promises an article for a search already drafted or held twice (a real signup, 2026-09-22)", async () => {
    // One search, three spellings: drafted, then two more held for the
    // trial. Their stored results pages overlap the drafted one's.
    const owners = { keywords: [{ id: "d", term: "mobil uygulama geliştirme şirketleri", status: "drafting", opportunity: { organicUrls: DRAFTED } }] };
    const held: Row[] = [
      { id: "a", term: "mobil uygulama geliştirme firmaları", opportunity: { status: "qualified", organicUrls: serp(DRAFTED, 6, "a") } },
      { id: "b", term: "mobil uygulama geliştirme firması", opportunity: { status: "qualified", organicUrls: serp(DRAFTED, 5, "b") } },
      { id: "c", term: "kurumsal web tasarım fiyatları", opportunity: { status: "qualified", organicUrls: page("c", 10) } },
    ];
    const out = await heldTopics(client(held, owners), "ws", 3, [], new Date("2026-09-22T00:00:00Z"));
    expect(out.count).toBe(1);
    expect(out.dates).toHaveLength(1);
  });
  it("without results pages, folds Turkish inflections but cannot see a synonym", async () => {
    // "firmaları"/"firması" are one word to the Turkish rules; "şirket" and
    // "firma" are synonyms, which only a results page shows.
    const owners = { keywords: [{ id: "d", term: "mobil uygulama geliştirme şirketleri", status: "drafting", opportunity: null }] };
    const held: Row[] = [
      { id: "a", term: "mobil uygulama geliştirme firmaları", opportunity: { status: "qualified" } },
      { id: "b", term: "MOBİL UYGULAMA GELİŞTİRME FIRMASI", opportunity: { status: "qualified" } },
      { id: "c", term: "kurumsal web tasarım fiyatları", opportunity: { status: "qualified" } },
    ];
    expect((await heldTopics(client(held, owners), "ws", 3, [])).count).toBe(2);
  });
  it("a planned row owns its search only while its verdict is an approval", async () => {
    // A refused calendar entry will not be written: it cannot hold the search
    // against a held phrasing that will (lib/keyword-research/intent-leaders.ts).
    const held: Row[] = [{ id: "a", term: "mobil uygulama geliştirme firmaları", opportunity: { status: "qualified" } }];
    const planned = (opportunity: unknown) => ({ keywords: [{ id: "p", term: "mobil uygulama geliştirme firması", status: "planned", opportunity }] });
    expect((await heldTopics(client(held, planned({ status: "rejected", cause: "buyer_mismatch" })), "ws", 3, [])).count).toBe(1);
    expect((await heldTopics(client(held, planned({ status: "qualified" })), "ws", 3, [])).count).toBe(0);
  });
  it("does not count a held topic a site page or a live article already answers", async () => {
    const held: Row[] = [
      { id: "a", term: "web tasarım fiyatları", opportunity: { status: "qualified" } },
      { id: "b", term: "e-ticaret sitesi kurulumu", opportunity: { status: "qualified" } },
      { id: "c", term: "seo ajansı", opportunity: { status: "qualified" } },
    ];
    const owners = {
      pages: [{ url: "https://acme-agency.example/fiyatlar", keyword: "web tasarımı fiyatı" }],
      articles: [{ id: "x", keyword: "E-ticaret siteleri kurulumu", keyword_id: null, status: "live" }],
    };
    expect((await heldTopics(client(held, owners), "ws", 3, [])).count).toBe(1);
  });
});

describe("stateFromRun", () => {
  const run = { id: "r", workspace_id: "ws", status: "done" as const, phases: [], planned: [{ term: "x", date: "2026-09-21" }], keywords_found: 1, article_id: null, error: null, started_at: "2026-09-21T00:00:00Z", updated_at: "2026-09-21T00:00:00Z", finished_at: null };
  it("carries the held topics the snapshot read", () => {
    expect(stateFromRun(run, null, { held: { count: 2, dates: ["2026-09-23", "2026-09-25"] } }).held).toEqual({ count: 2, dates: ["2026-09-23", "2026-09-25"] });
    expect(stateFromRun(run, null).held).toBeNull();
  });
});
