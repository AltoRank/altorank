import { describe, expect, it } from "vitest";
import { jsonbSafe, storableText } from "../jsonb-safe";

// Postgres refuses NUL in text and jsonb, and a lone surrogate in jsonb: one
// such character in a results page's description failed a first look's
// outline and then its whole article (2026-10-11).

describe("a value Postgres will store", () => {
  it("drops NUL and replaces lone surrogates, leaving real pairs alone", () => {
    expect(storableText("a\u0000b")).toBe("ab");
    expect(storableText("x\uD800y")).toBe("x\uFFFDy");
    expect(storableText("x\uDC00y")).toBe("x\uFFFDy");
    expect(storableText("ok \uD83D\uDE00")).toBe("ok \uD83D\uDE00");
  });

  it("cleans every string of a research blob, keys included, and leaves the input as it was", () => {
    const research = { competitors: [{ title: "T\u0000", description: "Prices\u0000 compared", rank: 1 }], ["k\u0000"]: [null, true, 2, "v\u0000"], at: new Date("2026-10-11T00:00:00Z") };
    const out = jsonbSafe(research);
    expect(JSON.stringify(out)).not.toContain("\\u0000");
    expect(out.competitors[0]).toEqual({ title: "T", description: "Prices compared", rank: 1 });
    expect((out as unknown as Record<string, unknown>).k).toEqual([null, true, 2, "v"]);
    expect((out as unknown as { at: unknown }).at).toBe("2026-10-11T00:00:00.000Z");
    expect(research.competitors[0].title).toBe("T\u0000");
  });
});
