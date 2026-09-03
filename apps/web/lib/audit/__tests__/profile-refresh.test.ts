import { describe, it, expect } from "vitest";
import {
  isProfileStale,
  selectStale,
  PROFILE_MAX_AGE_DAYS,
  type ProfileCandidate,
} from "../profile-refresh";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("isProfileStale", () => {
  it("is false for a profile built inside the window", () => {
    expect(isProfileStale(daysAgo(PROFILE_MAX_AGE_DAYS - 1), NOW)).toBe(false);
  });

  it("is true past the window", () => {
    expect(isProfileStale(daysAgo(PROFILE_MAX_AGE_DAYS + 1), NOW)).toBe(true);
  });

  /**
   * The rows that need a profile most are the ones that have no timestamp:
   * analysed before the field existed, or analysed and failed. `.lt()` on the
   * JSON key silently drops them, which is why staleness is decided here.
   */
  it("treats a missing timestamp as stale", () => {
    expect(isProfileStale(null, NOW)).toBe(true);
    expect(isProfileStale(undefined, NOW)).toBe(true);
  });

  it("treats an unparseable timestamp as stale rather than never selectable", () => {
    expect(isProfileStale("not a date", NOW)).toBe(true);
  });

  it("does not re-crawl on clock skew", () => {
    expect(isProfileStale(daysAgo(-2), NOW)).toBe(false);
  });
});

describe("selectStale", () => {
  const c = (id: string, built: string | null): ProfileCandidate => ({ id, domain: `${id}.com`, built });

  it("takes the oldest first and stops at the slot limit", () => {
    const picked = selectStale(
      [c("a", null), c("b", daysAgo(90)), c("c", daysAgo(60))],
      2,
      NOW,
    );
    expect(picked.map((p) => p.id)).toEqual(["a", "b"]);
  });

  /** Rows arrive ordered, so the first fresh one ends the scan. */
  it("stops at the first fresh candidate", () => {
    const picked = selectStale([c("a", daysAgo(90)), c("b", daysAgo(1)), c("c", null)], 3, NOW);
    expect(picked.map((p) => p.id)).toEqual(["a"]);
  });

  it("refreshes nothing when first-look analysis used every slot", () => {
    expect(selectStale([c("a", null)], 0, NOW)).toEqual([]);
  });

  it("skips a workspace with no domain rather than crawling https://null", () => {
    const picked = selectStale([{ id: "a", domain: null, built: null }, c("b", null)], 2, NOW);
    expect(picked.map((p) => p.id)).toEqual(["b"]);
  });
});
