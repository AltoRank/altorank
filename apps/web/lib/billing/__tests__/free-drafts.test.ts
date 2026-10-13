import { describe, expect, it } from "vitest";
import { recordFreeDraftWritten } from "../free-drafts";

/**
 * The free tier's counter moves by exactly one per draft written, from what
 * the column holds when the draft is saved - never from the count the run
 * read when it started, which on the in-place path already included the row
 * being written into and recorded every such draft twice (round-5 review).
 */

function account(start: number, opts: { interleave?: () => void } = {}) {
  const state = { value: start, writes: 0 };
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { free_drafts_used: state.value }, error: null }) }),
      }),
      update: (patch: { free_drafts_used: number }) => {
        const expected: Record<string, unknown> = {};
        const chain = {
          eq: (col: string, v: unknown) => ((expected[col] = v), chain),
          select: async () => {
            opts.interleave?.();
            opts.interleave = undefined;
            if (expected.free_drafts_used !== state.value) return { data: [], error: null };
            state.value = patch.free_drafts_used;
            state.writes += 1;
            return { data: [{ id: "acc1" }], error: null };
          },
        };
        return chain;
      },
    }),
  };
  return { state, client: client as never };
}

describe("recordFreeDraftWritten", () => {
  it("adds one to what the column holds", async () => {
    const { state, client } = account(2);
    await recordFreeDraftWritten(client, "acc1");
    expect(state.value).toBe(3);
  });

  it("adds its one even when another draft's increment lands in between", async () => {
    // Another draft moves 2 -> 3 between this one's read and its write: the
    // compare-and-set loses once, reads 3, and writes 4.
    const racing = account(2, {
      interleave: () => {
        racing.state.value = 3;
      },
    });
    await recordFreeDraftWritten(racing.client, "acc1");
    expect(racing.state.value).toBe(4);
    expect(racing.state.writes).toBe(1);
  });

  it("never throws: the live count floors the column", async () => {
    const broken = { from: () => { throw new Error("down"); } } as never;
    await expect(recordFreeDraftWritten(broken, "acc1")).resolves.toBeUndefined();
  });
});
