import { describe, it, expect } from "vitest";
import { validateCancellation, cancellationSummary, cancelButtonLabel, CANCEL_REASONS } from "../cancellation";

describe("cancellation survey", () => {
  it("lists the six reasons in the order shown", () => {
    expect(CANCEL_REASONS.map((r) => r.id)).toEqual(["quality", "no_results", "price", "switched", "no_need", "other"]);
  });
  it("requires a reason", () => {
    expect(validateCancellation({ reason: null })).toEqual({ ok: false, error: expect.stringContaining("reason") });
    expect(validateCancellation({ reason: "made-up" }).ok).toBe(false);
  });
  it("accepts a listed reason with optional detail", () => {
    expect(validateCancellation({ reason: "price" })).toEqual({ ok: true, reason: "price", detail: null });
    expect(validateCancellation({ reason: "price", detail: "  too much  " })).toEqual({ ok: true, reason: "price", detail: "too much" });
  });
  it("makes Other say something", () => {
    expect(validateCancellation({ reason: "other" }).ok).toBe(false);
    expect(validateCancellation({ reason: "other", detail: "ab" }).ok).toBe(false);
    expect(validateCancellation({ reason: "other", detail: "moved in-house" }).ok).toBe(true);
  });
  it("caps the free text", () => {
    const v = validateCancellation({ reason: "quality", detail: "x".repeat(5000) });
    expect(v.ok && v.detail?.length).toBe(2000);
  });
  it("names the date when it has one and never invents one", () => {
    expect(cancellationSummary("2026-10-01T00:00:00Z")).toBe(
      "You keep access until October 1, 2026. Your articles stay readable and exportable afterwards.",
    );
    expect(cancellationSummary(null)).toContain("the end of the current billing period");
  });
  it("says a trial's cancel stops drafting now and nothing is charged; the button says it too", () => {
    const s = cancellationSummary("2026-10-06T12:00:00Z", { trial: true });
    expect(s).toContain("Nothing is charged, and nothing new is drafted from now on.");
    expect(s).toContain("October 6, 2026");
    expect(s).not.toContain("You keep access");
    expect(cancelButtonLabel("2026-10-06T12:00:00Z", { trial: true })).toBe("Cancel trial — drafting stops now");
    expect(cancelButtonLabel("2026-12-01T12:00:00Z")).toBe("Cancel plan — writing stops December 1");
    expect(cancelButtonLabel(null)).toBe("Cancel plan — writing stops at the period end");
  });
});
