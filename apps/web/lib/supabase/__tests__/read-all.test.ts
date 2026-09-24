import { describe, expect, it } from "vitest";
import { PAGE_SIZE, readAllPages, type PageResult } from "../read-all";

// A table of `n` rows behind a server that hands back at most `cap` rows a
// request, whatever range was asked for: PostgREST's max_rows. `reportCount`
// false is a stub that never says how many rows matched.
function server(n: number, cap: number, reportCount = true) {
  const rows = Array.from({ length: n }, (_, i) => ({ i }));
  const calls: Array<{ from: number; to: number; count: string | undefined }> = [];
  const page = (from: number, to: number, count: "exact" | undefined): PromiseLike<PageResult<{ i: number }>> => {
    calls.push({ from, to, count });
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

  it("without a count, a page shorter than asked is the last", async () => {
    const { page, calls } = server(1500, PAGE_SIZE, false);
    expect(await readAllPages("probe", page)).toHaveLength(1500);
    expect(calls).toHaveLength(2);
  });

  it("throws on a database error rather than returning what it had", async () => {
    let n = 0;
    await expect(
      readAllPages("GA4 read", async () =>
        n++ === 0
          ? { data: Array.from({ length: PAGE_SIZE }, () => ({})), error: null, count: 3000 }
          : { data: null, error: { message: "boom" }, count: null },
      ),
    ).rejects.toThrow("GA4 read failed: boom");
  });
});
