import { describe, it, expect } from "vitest";
import { relativeDifficulty } from "../difficulty";

describe("relativeDifficulty", () => {
  it("reads the same KD differently for a strong and a new site", () => {
    const strong = relativeDifficulty(40, 80);
    const newSite = relativeDifficulty(40, 0);
    expect(strong.absolute).toBe(40);
    expect(newSite.absolute).toBe(40);
    // Same absolute number, opposite verdicts. This is the whole point.
    expect(strong.band).toBe("comfortable");
    expect(newSite.band).toBe("unrealistic");
  });

  it("stays null rather than guessing when authority is unmeasured", () => {
    // A guess here would sort unwinnable keywords to the top of a plan, which
    // is worse than showing nothing. Migration 022 makes the same argument
    // about difficulty itself: an unmeasured number is not a zero.
    const r = relativeDifficulty(40, null);
    expect(r.absolute).toBe(40);
    expect(r.relative).toBeNull();
    expect(r.band).toBeNull();
  });

  it("stays null when difficulty itself is unmeasured", () => {
    const r = relativeDifficulty(null, 50);
    expect(r.relative).toBeNull();
    expect(r.reason).toBe("difficulty not measured");
  });

  it("treats KD at the site's own authority as reachable", () => {
    expect(relativeDifficulty(30, 30).band).toBe("comfortable");
  });

  it("clamps rather than running off the scale", () => {
    expect(relativeDifficulty(100, 0).relative).toBe(100);
    expect(relativeDifficulty(0, 90).relative).toBe(0);
  });

  it("always explains itself in words", () => {
    for (const r of [relativeDifficulty(40, 80), relativeDifficulty(40, 0), relativeDifficulty(null, 1)]) {
      expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});
