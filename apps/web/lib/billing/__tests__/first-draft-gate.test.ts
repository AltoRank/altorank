import { describe, it, expect } from "vitest";
import { firstDraftBlocker, reviewed, type DraftSignal } from "../first-draft-gate";

const t0 = "2026-09-10T18:00:00.000Z";
const draft = (over: Partial<DraftSignal> = {}): DraftSignal => ({
  status: "review", generated_autonomously: true, approved_at: null, held_by: null,
  created_at: t0, updated_at: "2026-09-10T18:03:00.000Z", ...over,
});

describe("firstDraftBlocker — the free allowance's second draft waits for the first", () => {
  it("writes the first draft: nothing to wait for yet", () => {
    expect(firstDraftBlocker([])).toBeNull();
  });
  it("holds the second while the first sits unread", () => {
    expect(firstDraftBlocker([draft()])).toMatch(/waiting for your review/);
  });
  it("continues once the first was approved", () => {
    expect(firstDraftBlocker([draft({ approved_at: "2026-09-10T20:00:00.000Z" })])).toBeNull();
  });
  it("continues once the first was held - a hold is a read", () => {
    expect(firstDraftBlocker([draft({ held_by: "user-1" })])).toBeNull();
  });
  it("continues once the first was edited an hour later", () => {
    expect(firstDraftBlocker([draft({ updated_at: "2026-09-10T21:00:00.000Z" })])).toBeNull();
  });
  it("does not count the pipeline's own scoring writes as a read", () => {
    expect(reviewed(draft({ updated_at: "2026-09-10T18:04:30.000Z" }))).toBe(false);
  });
  it("does not count a draft the platform killed", () => {
    expect(firstDraftBlocker([draft({ status: "error" })])).toBeNull();
  });
  it("does not gate a draft a person asked for by hand", () => {
    expect(firstDraftBlocker([draft({ generated_autonomously: false })])).toBeNull();
  });
  it("one reviewed draft unlocks the rest even with unread ones beside it", () => {
    expect(firstDraftBlocker([draft(), draft({ approved_at: "2026-09-10T20:00:00.000Z" })])).toBeNull();
  });
});
