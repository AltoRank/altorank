import { describe, it, expect, vi, beforeEach } from "vitest";

const post = vi.fn();
const get = vi.fn();
vi.mock("../client", () => ({ post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) }));

import {
  encodeRankTag,
  decodeRankTag,
  positionFor,
  postRankingTasks,
  collectRankingTasks,
} from "../serp";

beforeEach(() => {
  post.mockReset();
  get.mockReset();
});

describe("rank tags", () => {
  it("round-trips a workspace and keyword id", () => {
    const tag = encodeRankTag("ws-1", "kw-9");
    expect(decodeRankTag(tag)).toEqual({ workspaceId: "ws-1", keywordId: "kw-9" });
  });

  it("refuses tags it did not write", () => {
    // The account may carry other queued work; a collector that adopted it
    // would record somebody else's SERPs against our keywords.
    expect(decodeRankTag("brief|ws-1|kw-9")).toBeNull();
    expect(decodeRankTag("rank|ws-1")).toBeNull();
    expect(decodeRankTag(null)).toBeNull();
  });
});

describe("positionFor", () => {
  const items = [
    { type: "paid", rank_group: 1, rank_absolute: 1, domain: "ads.example", url: "", title: "" },
    { type: "organic", rank_group: 1, rank_absolute: 2, domain: "www.calendly.com", url: "https://calendly.com/x", title: "" },
    { type: "organic", rank_group: 2, rank_absolute: 3, domain: "cal.com", url: "https://cal.com/y", title: "" },
  ];

  it("ignores paid results and matches www and bare forms alike", () => {
    expect(positionFor(items, "calendly.com")).toEqual({ position: 1, url: "https://calendly.com/x" });
    expect(positionFor(items, "https://www.cal.com/")).toEqual({ position: 2, url: "https://cal.com/y" });
  });

  it("returns null, never 0, when the domain is absent", () => {
    // Migration 026: rank 0 sorted ahead of rank 1 and dragged every average
    // toward zero. NULL means "checked, not found".
    expect(positionFor(items, "nowhere.example")).toEqual({ position: null, url: null });
    expect(positionFor(null, "cal.com")).toEqual({ position: null, url: null });
  });
});

describe("postRankingTasks", () => {
  it("splits into POSTs of at most 100 tasks and counts 20100 as posted", async () => {
    post.mockImplementation(async (_e: string, body: unknown[]) => ({
      tasks: (body as unknown[]).map(() => ({ status_code: 20100 })),
    }));
    const tasks = Array.from({ length: 150 }, (_, i) => ({ keywordId: `kw-${i}`, term: `term ${i}` }));
    const r = await postRankingTasks("ws-1", tasks);
    expect(post).toHaveBeenCalledTimes(2);
    expect((post.mock.calls[0][1] as unknown[]).length).toBe(100);
    expect((post.mock.calls[1][1] as unknown[]).length).toBe(50);
    expect(r).toEqual({ posted: 150, failed: 0 });
  });

  it("uses the standard queue and stamps every task with its tag", async () => {
    post.mockResolvedValue({ tasks: [{ status_code: 20100 }] });
    await postRankingTasks("ws-1", [{ keywordId: "kw-9", term: "scheduler" }]);
    const body = post.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(post.mock.calls[0][0]).toBe("/serp/google/organic/task_post");
    expect(body[0].priority).toBe(1);
    expect(body[0].tag).toBe("rank|ws-1|kw-9");
  });

  it("counts a refused task as failed rather than throwing", async () => {
    post.mockResolvedValue({ tasks: [{ status_code: 20100 }, { status_code: 40006 }] });
    const r = await postRankingTasks("ws-1", [
      { keywordId: "a", term: "a" },
      { keywordId: "b", term: "b" },
    ]);
    expect(r).toEqual({ posted: 1, failed: 1 });
  });
});

describe("collectRankingTasks", () => {
  it("collects only tasks carrying our tag, and fetches each by id", async () => {
    get.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/tasks_ready")) {
        return {
          tasks: [{ result: [
            { id: "t-ours", tag: "rank|ws-1|kw-9" },
            { id: "t-theirs", tag: "brief|x|y" },
            { id: "t-untagged", tag: null },
          ] }],
        };
      }
      if (endpoint.endsWith("/task_get/regular/t-ours")) {
        return { tasks: [{ result: [{ keyword: "scheduler", items: [] }] }] };
      }
      throw new Error("unexpected " + endpoint);
    });
    const out = await collectRankingTasks();
    expect(get).toHaveBeenCalledTimes(2);
    expect(out).toEqual([{ workspaceId: "ws-1", keywordId: "kw-9", keyword: "scheduler", items: [] }]);
  });

  it("survives one task_get failing", async () => {
    get.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/tasks_ready")) {
        return { tasks: [{ result: [{ id: "t1", tag: "rank|w|a" }, { id: "t2", tag: "rank|w|b" }] }] };
      }
      if (endpoint.endsWith("/t1")) throw new Error("gone");
      return { tasks: [{ result: [{ keyword: "b", items: null }] }] };
    });
    const out = await collectRankingTasks();
    expect(out.map((o) => o.keywordId)).toEqual(["b"]);
  });
});
