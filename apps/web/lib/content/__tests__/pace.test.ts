import { describe, expect, it } from "vitest";
import {
  FREE_TIER_PACE,
  MAX_PACE,
  PAID_DEFAULT_PACE,
  monthlyFromPace,
  normalisePace,
  paceOnActivation,
} from "../pace";

describe("paceOnActivation", () => {
  it("raises the free-tier pace to the paid default", () => {
    // The bug this exists for: an account went from 1 a week to 1 a week when
    // it started paying, about four articles a month against a sold 100.
    expect(paceOnActivation(FREE_TIER_PACE)).toBe(PAID_DEFAULT_PACE);
    expect(paceOnActivation(null)).toBe(PAID_DEFAULT_PACE);
    expect(paceOnActivation(undefined)).toBe(PAID_DEFAULT_PACE);
  });

  it("never overrules a number the customer chose", () => {
    // Anything above the free-tier value was set by somebody, and paying is
    // not a reason to overrule them.
    expect(paceOnActivation(2)).toBeNull();
    expect(paceOnActivation(14)).toBeNull();
    expect(paceOnActivation(MAX_PACE)).toBeNull();
  });

  it("leaves a deliberately paused site paused", () => {
    // 0 is how a site is paused. Activating a plan must not start it writing.
    expect(paceOnActivation(0)).toBeNull();
  });
});

describe("normalisePace", () => {
  it("accepts the whole allowed range including both ends", () => {
    expect(normalisePace(0)).toBe(0);
    expect(normalisePace(MAX_PACE)).toBe(MAX_PACE);
    expect(normalisePace("7")).toBe(7);
  });

  it("refuses what the column would refuse, rather than clamping silently", () => {
    // Clamping would accept a request and do something else, which is how a
    // form ends up lying about what it saved.
    expect(normalisePace(-1)).toBeNull();
    expect(normalisePace(MAX_PACE + 1)).toBeNull();
    expect(normalisePace("nonsense")).toBeNull();
    expect(normalisePace(undefined)).toBeNull();
    expect(normalisePace(Number.NaN)).toBeNull();
  });

  it("rounds a fractional request to a whole article", () => {
    expect(normalisePace(3.4)).toBe(3);
    expect(normalisePace(3.6)).toBe(4);
  });
});

describe("monthlyFromPace", () => {
  it("uses rolling weeks, so the maximum clears the plan it was raised for", () => {
    // 041 raised the ceiling from 20 to 25 precisely so 100 is reachable.
    expect(monthlyFromPace(20)).toBe(87);
    expect(monthlyFromPace(MAX_PACE)).toBe(108);
    expect(monthlyFromPace(MAX_PACE)).toBeGreaterThan(100);
  });

  it("describes the two defaults honestly", () => {
    expect(monthlyFromPace(FREE_TIER_PACE)).toBe(4);
    expect(monthlyFromPace(PAID_DEFAULT_PACE)).toBe(30);
    expect(monthlyFromPace(2)).toBe(9);
  });

  it("is zero for a paused site", () => {
    expect(monthlyFromPace(0)).toBe(0);
  });
});
