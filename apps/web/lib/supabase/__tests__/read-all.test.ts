import { describe, expect, it } from "vitest";
import { PAGE_SIZE, readAllPages, type PageResult } from "../read-all";

// A table of `n` rows behind a server that hands back at most `cap` rows a
// request, whatever range was asked for: PostgREST's max_rows. `reportCount`
// false is a query whose select was not given the count, so the server never
// says how many rows matched. `failAt` fails every page from that offset on.
function server(n: number, cap: number, { reportCount = true, failAt = null as number | null } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({ i }));
  const calls: Array<{ from: number; to: number; count: string | undefined }> = [];
  const page = (from: number, to: number, count: "exact" | undefined): PromiseLike<PageResult<{ i: number }>> => {
    calls.push({ from, to, count });
    if (failAt !== null && from >= failAt) {
      return Promise.resolve({ data: null, error: { message: "statement timeout" }, count: null });
    }
    const end = Math.min(to + 1, from + cap);
    return Promise.resolve({
      data: rows.slice(from, end),
      error: null,
      count: reportCount && count === "exact" ? n : null,
    });
  };
  return { page, calls };
}

describe("readAllPages", () => {
  it("reads every row past the page size", async () => {
    const { page, calls } = server(2500, PAGE_SIZE);
    const rows = await readAllPages("probe", page);
    expect(rows.map((r) => r.i)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
    // Only the first page asks for the count.
    expect(calls.map((c) => c.count)).toEqual(["exact", undefined, undefined]);
  });

  it("reads past the server's 1,000-row cap (round-4 review: 1,100 site pages, 1,000 came back)", async () => {
    const { page, calls } = server(1100, 1000);
    expect(await readAllPages("probe", page)).toHaveLength(1100);
    expect(calls.map((c) => [c.from, c.to])).toEqual([[0, 999], [1000, 1999]]);
  });

  it("reads every row when the server's cap is below the page it asked for", async () => {
    // The short-page rule would have stopped after 400 rows and called it the
    // whole table; the count keeps it reading.
    const { page } = server(2500, 400);
    const rows = await readAllPages("probe", page);
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.i)).size).toBe(2500);
  });

  it("one round trip when everything fits in the first page", async () => {
    const { page, calls } = server(12, PAGE_SIZE);
    expect(await readAllPages("probe", page)).toHaveLength(12);
    expect(calls).toHaveLength(1);
  });

  it("one round trip for an exactly full first page: the count says it is all", async () => {
    const { page, calls } = server(PAGE_SIZE, PAGE_SIZE);
    expect(await readAllPages("probe", page)).toHaveLength(PAGE_SIZE);
    expect(calls).toHaveLength(1);
  });

  it("one round trip for an empty table", async () => {
    const { page, calls } = server(0, PAGE_SIZE);
    expect(await readAllPages("probe", page)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("ends on an empty page even when the count promised more", async () => {
    // Rows deleted between the count and the next page.
    let first = true;
    const rows = await readAllPages<{ i: number }>("probe", async () => {
      if (!first) return { data: [], error: null, count: null };
      first = false;
      return { data: Array.from({ length: PAGE_SIZE }, (_, i) => ({ i })), error: null, count: 5000 };
    });
    expect(rows).toHaveLength(PAGE_SIZE);
  });

  it("refuses a read whose first page reports no count, instead of guessing from a short page", async () => {
    // The caller forgot `{ count }` in its select. The short-page rule would
    // have read these 1,500 rows correctly, and with a server cap below the
    // page size it would have read 400 and called it everything.
    const { page } = server(1500, 400, { reportCount: false });
    await expect(readAllPages("site pages read", page)).rejects.toThrow(
      "site pages read: the first page reported no row count",
    );
  });

  it("throws on a database error rather than returning what it had: half the rows is not the rows", async () => {
    const { page } = server(2500, PAGE_SIZE, { failAt: 1000 });
    await expect(readAllPages("GA4 read", page)).rejects.toThrow("GA4 read failed: statement timeout");
  });

  it("throws when the first page fails", async () => {
    const { page } = server(2500, PAGE_SIZE, { failAt: 0 });
    await expect(readAllPages("probe", page)).rejects.toThrow("probe failed: statement timeout");
  });
});
