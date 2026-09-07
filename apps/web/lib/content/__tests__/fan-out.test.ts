import { describe, it, expect, vi } from "vitest";
import { fanOutDrafts, MAX_FAN_OUT } from "../fan-out";
import {
  MAX_ARTICLES_PER_RUN,
  OBSERVED_SECONDS_PER_ARTICLE,
  RUN_BUDGET_SECONDS,
} from "../generate-queue";

const targets = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ keywordId: `k${i}`, term: `term ${i}` }));

const deps = (fetchImpl: typeof fetch) => ({
  baseUrl: "https://app.example.com",
  secret: "s3cret",
  fetchImpl,
});

describe("fanOutDrafts", () => {
  it("sends one request per draft, so they run concurrently", () => {
    const f = vi.fn().mockResolvedValue(new Response("{}"));
    const r = fanOutDrafts("ws1", targets(6), deps(f as unknown as typeof fetch));
    expect(r.dispatched).toBe(6);
    expect(f).toHaveBeenCalledTimes(6);
    // One draft per call is the point: a loop inside one request would rebuild
    // the per-invocation bottleneck this exists to remove.
    const bodies = f.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies.map((b) => b.keywordId)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5"]);
    expect(new Set(bodies.map((b) => b.workspaceId))).toEqual(new Set(["ws1"]));
  });

  it("authenticates server-to-server, since there is no session to forward", () => {
    const f = vi.fn().mockResolvedValue(new Response("{}"));
    fanOutDrafts("ws1", targets(1), deps(f as unknown as typeof fetch));
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-cron-secret"]).toBe("s3cret");
    expect(f.mock.calls[0][0]).toBe("https://app.example.com/api/internal/draft");
  });

  it("caps the burst rather than firing a whole month at the model", () => {
    const f = vi.fn().mockResolvedValue(new Response("{}"));
    const r = fanOutDrafts("ws1", targets(30), deps(f as unknown as typeof fetch));
    expect(r.dispatched).toBe(MAX_FAN_OUT);
    expect(f).toHaveBeenCalledTimes(MAX_FAN_OUT);
  });

  it("no-ops without a secret or a base URL instead of throwing", () => {
    const f = vi.fn();
    expect(fanOutDrafts("ws1", targets(3), { baseUrl: "https://x", secret: null, fetchImpl: f as never }))
      .toMatchObject({ dispatched: 0, skipped: "no-secret" });
    expect(fanOutDrafts("ws1", targets(3), { baseUrl: null, secret: "s", fetchImpl: f as never }))
      .toMatchObject({ dispatched: 0, skipped: "no-base-url" });
    expect(fanOutDrafts("ws1", [], deps(f as never)))
      .toMatchObject({ dispatched: 0, skipped: "nothing-to-do" });
    expect(f).not.toHaveBeenCalled();
  });

  it("does not reject when a dispatch fails: the entry is left for the cron", async () => {
    const f = vi.fn().mockRejectedValue(new Error("network down"));
    expect(() => fanOutDrafts("ws1", targets(2), deps(f as unknown as typeof fetch))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("the arithmetic this exists for: a week does not fit in one invocation", () => {
    // Why fan out at all. Two sequential drafts fit in a 300s function and
    // three do not, which is why cron/generate caps at two - so seven can only
    // be fast if they are seven invocations.
    expect(OBSERVED_SECONDS_PER_ARTICLE * MAX_ARTICLES_PER_RUN).toBeLessThan(RUN_BUDGET_SECONDS);
    expect(OBSERVED_SECONDS_PER_ARTICLE * (MAX_ARTICLES_PER_RUN + 1)).toBeGreaterThan(RUN_BUDGET_SECONDS);
    // And one fan-out draft is comfortably inside its own budget.
    expect(OBSERVED_SECONDS_PER_ARTICLE).toBeLessThan(RUN_BUDGET_SECONDS);
  });
});
