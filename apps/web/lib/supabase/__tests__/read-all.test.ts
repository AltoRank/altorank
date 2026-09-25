import { describe, it, expect } from "vitest";
import { readAll } from "../read-all";

/** A server with the hosted cap: never more than 1,000 rows a response. */
function server(total: number, failAt: number | null = null) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const asked: Array<[number, number]> = [];
  const page = async (from: number, to: number) => {
    asked.push([from, to]);
    if (failAt !== null && from >= failAt) return { data: null, error: { message: "statement timeout" } };
    return { data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null };
  };
  return { page, asked };
}

describe("readAll", () => {
  it("reads past the server's 1,000-row cap (round-4 review: 1,100 site pages, 1,000 came back)", async () => {
    const { page, asked } = server(1100);
    const res = await readAll(page);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1100);
    expect(asked).toEqual([[0, 999], [1000, 1999]]);
  });

  it("asks once when the first page is short", async () => {
    const { page, asked } = server(3);
    expect((await readAll(page)).data).toHaveLength(3);
    expect(asked).toHaveLength(1);
  });

  it("asks for the page after an exactly full one, and stops at the empty one", async () => {
    const { page, asked } = server(1000);
    expect((await readAll(page)).data).toHaveLength(1000);
    expect(asked).toHaveLength(2);
  });

  it("fails the whole read when any page fails: half the rows is not the rows", async () => {
    const { page } = server(2500, 1000);
    const res = await readAll(page);
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe("statement timeout");
  });
});
