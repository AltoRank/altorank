import { describe, it, expect } from "vitest";
import { roomForAnother, OBSERVED_SECONDS_PER_ARTICLE, RUN_BUDGET_SECONDS } from "../generate-queue";

/**
 * 2026-09-09 18:49 UTC: the first draft of the run took 209 seconds, the
 * second was started with 91 left, and Vercel killed the function under it.
 * A count cannot see that coming; a clock can.
 */
const s = (n: number) => n * 1000;
const BUDGET = s(RUN_BUDGET_SECONDS);

describe("roomForAnother", () => {
  it("refuses the second draft that was killed", () => {
    expect(roomForAnother(s(209), s(209))).toBe(false);
  });

  it("allows a second draft when the budget genuinely holds one, with margin", () => {
    // The reserve is the observation (209s) x 1.2 = 251s, whatever the last
    // draft took. 209s in with a 600s budget leaves 391s: room.
    expect(roomForAnother(s(209), s(209), s(600))).toBe(true);
    // 209s in with a 450s budget leaves 241s: not room, by ten seconds.
    expect(roomForAnother(s(209), s(209), s(450))).toBe(false);
  });

  it("does not trust a fast first draft below the recorded observation", () => {
    // A 60s draft is not a promise the next is 60s. The reserve is never less
    // than what has been measured in production.
    const need = OBSERVED_SECONDS_PER_ARTICLE * 1.2;
    expect(roomForAnother(BUDGET - s(need) + s(1), s(60))).toBe(false);
    expect(roomForAnother(BUDGET - s(need) - s(1), s(60))).toBe(true);
  });

  it("falls back to the observation when nothing has been measured this run", () => {
    expect(roomForAnother(0, null)).toBe(true);
    expect(roomForAnother(BUDGET - s(OBSERVED_SECONDS_PER_ARTICLE), null)).toBe(false);
  });

  it("uses the slower of last draft and observation", () => {
    // Last draft 250s > observed 209s: reserve is 300s, never fits.
    expect(roomForAnother(0, s(250))).toBe(true);
    expect(roomForAnother(s(1), s(250))).toBe(false);
  });
});
