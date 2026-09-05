import { describe, it, expect, vi, beforeEach } from "vitest";

// The action is update().eq() on one table; every link returns itself and the
// awaited result is whatever the test set. What was written, and to which row,
// is what the assertions care about.
let result: { error: unknown } = { error: null };
const update = vi.fn();
const eq = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      update: (row: unknown) => {
        update(row);
        return {
          eq: (col: string, val: string) => {
            eq(col, val);
            return Promise.resolve(result);
          },
        };
      },
    }),
  }),
}));

// Hoisted so the mock factory, which vitest lifts above the imports, can see it.
const { requireAuth } = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({ agencyId: "agency-1", role: "editor", user: { id: "u1" } })),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

async function save(source: string, note: string | null = null) {
  const { saveAttribution } = await import("../attribution");
  return saveAttribution(source, note);
}

beforeEach(() => {
  result = { error: null };
  update.mockClear();
  eq.mockClear();
  requireAuth.mockClear();
});

describe("saveAttribution", () => {
  it("writes the answer to the caller's own account row", async () => {
    await expect(save("ai")).resolves.toEqual({ source: "ai", note: null });
    expect(eq).toHaveBeenCalledWith("id", "agency-1");
    const row = update.mock.calls[0][0] as Record<string, unknown>;
    expect(row.attribution_source).toBe("ai");
    expect(row.attribution_note).toBeNull();
    expect(typeof row.attribution_answered_at).toBe("string");
  });

  it("refuses a source outside the list before touching auth or the database", async () => {
    await expect(save("carrier pigeon")).rejects.toThrow();
    expect(requireAuth).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses Other with nothing behind it", async () => {
    await expect(save("other", "  ")).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    await expect(save("other", "a Slack community")).resolves.toEqual({ source: "other", note: "a Slack community" });
  });

  it("does not require a role: any member may answer", async () => {
    await save("google");
    expect(requireAuth).toHaveBeenCalledWith();
  });

  it("surfaces a database failure instead of pretending it saved", async () => {
    result = { error: { message: "boom" } };
    await expect(save("reddit")).rejects.toThrow("boom");
  });
});
