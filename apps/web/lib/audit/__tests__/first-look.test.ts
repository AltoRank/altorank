import { describe, it, expect } from "vitest";
import {
  MAX_ANALYSIS_ATTEMPTS,
  decideFirstLook,
  firstLookPatch,
  retryEligibleBefore,
} from "../first-look";

const NOW_ISO = "2026-09-09T18:38:05.000Z";
const blip = { attemptsBefore: 0, pagesCrawled: 0, failedForGood: false };

describe("decideFirstLook", () => {
  it("settles as soon as a run reads the site", () => {
    expect(decideFirstLook({ ...blip, pagesCrawled: 8 })).toEqual({ attempts: 1, settled: true, reason: "read" });
  });

  it("reads on a later attempt too, and stops counting there", () => {
    expect(decideFirstLook({ ...blip, attemptsBefore: 2, pagesCrawled: 1 })).toEqual({
      attempts: 3,
      settled: true,
      reason: "read",
    });
  });

  it("does not settle a run whose crawl failed for a reason that clears on its own", () => {
    // A real signup, 2026-09-09: one audit, pages_crawled 0, first_analysed_at
    // stamped anyway - which is what removed it from the first-look queue for
    // good while the site crawled fine minutes later.
    expect(decideFirstLook(blip)).toEqual({ attempts: 1, settled: false, reason: "retry" });
  });

  it("settles a crawl that failed for good, with no retries: tomorrow's answer is the same", () => {
    expect(decideFirstLook({ ...blip, failedForGood: true })).toEqual({
      attempts: 1,
      settled: true,
      reason: "unreachable",
    });
  });

  it("gives up once the attempts are spent, so a host that times out nightly is not retried for ever", () => {
    const last = decideFirstLook({ ...blip, attemptsBefore: MAX_ANALYSIS_ATTEMPTS - 1 });
    expect(last).toEqual({ attempts: MAX_ANALYSIS_ATTEMPTS, settled: true, reason: "gave-up" });
  });

  it("stays settled if a workspace somehow comes back over the cap", () => {
    expect(decideFirstLook({ ...blip, attemptsBefore: 9 }).settled).toBe(true);
  });

  it("treats a negative or missing count as none", () => {
    expect(decideFirstLook({ ...blip, attemptsBefore: -3 }).attempts).toBe(1);
  });

  it("takes the cap as an argument so the test does not pin the constant", () => {
    expect(decideFirstLook(blip, 1)).toMatchObject({ settled: true, reason: "gave-up" });
  });
});

describe("firstLookPatch", () => {
  it("stamps first_analysed_at only when the decision settled", () => {
    expect(firstLookPatch(decideFirstLook({ ...blip, pagesCrawled: 8 }), NOW_ISO)).toEqual({
      analysis_attempts: 1,
      last_analysis_attempt_at: NOW_ISO,
      first_analysed_at: NOW_ISO,
    });
    expect(firstLookPatch(decideFirstLook(blip), NOW_ISO)).toEqual({
      analysis_attempts: 1,
      last_analysis_attempt_at: NOW_ISO,
    });
  });

  it("records the attempt even when it does not settle", () => {
    const patch = firstLookPatch(decideFirstLook({ ...blip, attemptsBefore: 1 }), NOW_ISO);
    expect(patch.analysis_attempts).toBe(2);
    expect(patch.last_analysis_attempt_at).toBe(NOW_ISO);
    expect(patch.first_analysed_at).toBeUndefined();
  });
});

describe("retryEligibleBefore", () => {
  it("is the backoff behind now", () => {
    expect(retryEligibleBefore(new Date("2026-09-09T18:00:00Z"), 6)).toBe("2026-09-09T12:00:00.000Z");
  });
});
