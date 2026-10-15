import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());
vi.mock("../client", () => ({ post }));

import { BACKLINK_FETCH_LIMIT, syncBacklinks } from "../backlinks";

const item = (domain: string) => ({ domain_from: domain, url_to: "https://x.co/", domain_from_rank: 100 });

/** Stored rows, the upsert and the lost updates, recorded. */
function fakeDb(existing: { source_domain: string; target_url: string; status: string }[]) {
  const lostMarked: string[] = [];
  const client = {
    from: () => {
      let updating = false;
      const eqs: Record<string, unknown> = {};
      const b: Record<string, unknown> = {
        select: () => b,
        upsert: async () => ({ error: null }),
        update: () => {
          updating = true;
          return b;
        },
        eq: (k: string, v: unknown) => {
          eqs[k] = v;
          return b;
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (updating) {
            lostMarked.push(eqs.source_domain as string);
            return resolve({ error: null });
          }
          return resolve({ data: existing, error: null });
        },
      };
      return b;
    },
  };
  return { client: client as never, lostMarked };
}

const stored = [
  { source_domain: "a.co", target_url: "https://x.co/", status: "live" },
  { source_domain: "gone.co", target_url: "https://x.co/", status: "live" },
];

beforeEach(() => post.mockReset());

describe("syncBacklinks", () => {
  it("marks a missing domain lost when the check read every referring domain", async () => {
    post.mockResolvedValue({ tasks: [{ result: [{ total_count: 1, items: [item("a.co")] }] }] });
    const db = fakeDb(stored);
    const r = await syncBacklinks(db.client, "ws", "x.co");
    expect(r).toMatchObject({ fetched: 1, lost: 1, capped: false });
    expect(db.lostMarked).toEqual(["gone.co"]);
  });

  it("marks nothing lost when the check stopped at its limit: the domain may only have ranked lower", async () => {
    const full = Array.from({ length: BACKLINK_FETCH_LIMIT }, (_, i) => item(i === 0 ? "a.co" : `d${i}.co`));
    post.mockResolvedValue({ tasks: [{ result: [{ total_count: 5000, items: full }] }] });
    const db = fakeDb(stored);
    const r = await syncBacklinks(db.client, "ws", "x.co");
    expect(r).toMatchObject({ fetched: BACKLINK_FETCH_LIMIT, lost: 0, capped: true, total: 5000 });
    expect(db.lostMarked).toEqual([]);
  });
});
