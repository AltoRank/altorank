import { describe, it, expect, vi } from "vitest";
import { prepareRetry } from "../retry";
import { canRetryPublish } from "../log";

type Log = { id: string; status: "success" | "error"; error?: string; destination_id?: string | null; publish_mode?: string | null; created_at: string };

/**
 * Enough of a Supabase client for prepareRetry: one article, its log rows
 * newest first, and a record of what was written back.
 */
function mockSupabase(article: Record<string, unknown> | null, log: Log[]) {
  const updates: Record<string, unknown>[] = [];
  const supabase = {
    updates,
    from: vi.fn((table: string) => {
      if (table === "articles") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: article, error: article ? null : { message: "no" } }),
            }),
          }),
          update: vi.fn((patch: Record<string, unknown>) => {
            updates.push(patch);
            return { eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) };
          }),
        };
      }
      if (table === "publish_log") {
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: log.slice(0, 1) }),
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
  return supabase;
}

const approved = { id: "a1", workspace_id: "w1", status: "approved", approved_by: "u1" };
const failed: Log = { id: "log-1", status: "error", error: "500", destination_id: "wi-ghost", publish_mode: "draft", created_at: "2026-09-04T00:00:00Z" };

describe("prepareRetry", () => {
  it("refuses when the article was never published", async () => {
    const supabase = mockSupabase(approved, []);
    await expect(prepareRetry(supabase as never, "a1")).rejects.toThrow("never been published");
  });

  it("refuses when the last attempt succeeded, even if an older one failed", async () => {
    const supabase = mockSupabase(approved, [
      { id: "log-2", status: "success", created_at: "2026-09-04T01:00:00Z" },
      failed,
    ]);
    await expect(prepareRetry(supabase as never, "a1")).rejects.toThrow("last publish of this article succeeded");
  });

  it("hands back the failed attempt so the same destination is reused and logged as retry_of", async () => {
    const supabase = mockSupabase(approved, [failed]);
    const plan = await prepareRetry(supabase as never, "a1");
    expect(plan.workspaceId).toBe("w1");
    expect(plan.last.id).toBe("log-1");
    expect(plan.last.destination_id).toBe("wi-ghost");
    expect(supabase.updates).toEqual([]);
  });

  it("puts a cron-failed article back to approved, keeping its recorded approval", async () => {
    const supabase = mockSupabase({ ...approved, status: "error" }, [failed]);
    await prepareRetry(supabase as never, "a1");
    expect(supabase.updates[0]).toMatchObject({ status: "approved" });
  });

  it("will not resurrect an 'error' article that was never approved", async () => {
    const supabase = mockSupabase({ ...approved, status: "error", approved_by: null }, [failed]);
    await expect(prepareRetry(supabase as never, "a1")).rejects.toThrow("no recorded approval");
    expect(supabase.updates).toEqual([]);
  });

  it("sends a review-state article back to approval instead of publishing it", async () => {
    const supabase = mockSupabase({ ...approved, status: "review" }, [failed]);
    await expect(prepareRetry(supabase as never, "a1")).rejects.toThrow("Approve the article before retrying");
  });

  it("refuses an unknown article", async () => {
    const supabase = mockSupabase(null, [failed]);
    await expect(prepareRetry(supabase as never, "a1")).rejects.toThrow("Article not found");
  });
});

describe("canRetryPublish", () => {
  it("is true only for a failed last attempt on an article a publish can start from", () => {
    expect(canRetryPublish({ status: "error" }, "approved")).toBe(true);
    expect(canRetryPublish({ status: "error" }, "error")).toBe(true);
    expect(canRetryPublish({ status: "error" }, "scheduled")).toBe(true);
    expect(canRetryPublish({ status: "error" }, "review")).toBe(false);
    expect(canRetryPublish({ status: "error" }, "live")).toBe(false);
    expect(canRetryPublish({ status: "success" }, "approved")).toBe(false);
    expect(canRetryPublish(null, "approved")).toBe(false);
    expect(canRetryPublish(undefined, "error")).toBe(false);
  });
});
