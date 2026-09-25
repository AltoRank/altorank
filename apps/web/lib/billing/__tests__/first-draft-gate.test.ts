import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { firstDraftAwaitsReview, firstDraftBlocker, reviewed, type DraftSignal } from "../first-draft-gate";

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

  it("does not take a draft found on the customer's site for a person's review", () => {
    // The nightly check marks a find `live` (lib/found-on-site). That is not a
    // decision anyone made here, and must not restart unattended drafting on
    // the free allowance before the trial.
    const found = draft({ status: "live", found_on_site_at: "2026-09-11T10:00:00.000Z" });
    expect(reviewed(found)).toBe(false);
    expect(firstDraftBlocker([found])).toMatch(/waiting for your review/);
    // A person's own signals on the same row still count.
    expect(reviewed({ ...found, approved_at: "2026-09-10T20:00:00.000Z" })).toBe(true);
    expect(reviewed({ ...found, updated_at: "2026-09-10T21:00:00.000Z" })).toBe(true);
    // Live without a find is a publish, which a person asked for.
    expect(reviewed(draft({ status: "live" }))).toBe(true);
  });
});

describe("firstDraftAwaitsReview", () => {
  const client = (result: { data: unknown; error: { message: string } | null }) =>
    ({ from: () => ({ select: () => ({ eq: async () => result }) }) }) as unknown as SupabaseClient;

  it("fails closed, and says why, when the drafts cannot be read", async () => {
    // Read as "no drafts", a failed read would open the gate for every free
    // account at once: a missing column before 094, or a timeout.
    const why = await firstDraftAwaitsReview(client({ data: null, error: { message: "column articles.found_on_site_at does not exist" } }), "ws-1");
    expect(why).toMatch(/could not be read/);
    expect(why).toContain("found_on_site_at");
  });

  it("answers from the rows when it can read them", async () => {
    expect(await firstDraftAwaitsReview(client({ data: [draft()], error: null }), "ws-1")).toMatch(/waiting for your review/);
    expect(await firstDraftAwaitsReview(client({ data: [], error: null }), "ws-1")).toBeNull();
  });
});
