import { describe, it, expect } from "vitest";
import { FakeDb } from "./fake-postgrest";
import {
  CLAIM_LEASE_MS,
  claimEntry,
  claimsInFlight,
  recordEntryFailure,
  recordUnclaimedFailure,
  releaseClaim,
} from "../draft-claim";

/**
 * Claim before act (migration 093). The fake applies the WHERE of each
 * conditional update and resolves after a tick, so callers that race really
 * do read and write the same row; the local-database test beside this one
 * checks the same claim against Postgres itself.
 */

const NOW = new Date("2026-09-25T10:00:00.000Z");
const entry = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  workspace_id: "ws1",
  status: "queue",
  article_id: null,
  keyword: "crm for agencies",
  scheduled_date: "2026-09-26",
  draft_claimed_at: null,
  draft_claimed_by: null,
  draft_failed_at: null,
  draft_failure: null,
  ...over,
});

describe("claimEntry", () => {
  it("lets exactly one of several racing writers win an entry", async () => {
    const db = new FakeDb({ calendar_entries: [entry()] });
    const wins = await Promise.all(["trial:sub_1", "trial:sub_1", "cron:1", "cron:2"].map((by) => claimEntry(db.client, "e1", by, { now: NOW })));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("never claims an entry that already has its article, or one no longer queued", async () => {
    const db = new FakeDb({ calendar_entries: [entry({ article_id: "a1" }), entry({ id: "e2", status: "scheduled" })] });
    expect(await claimEntry(db.client, "e1", "cron:1", { now: NOW })).toBe(false);
    expect(await claimEntry(db.client, "e2", "cron:1", { now: NOW })).toBe(false);
  });

  it("hands a failed entry, or one whose lease ran out, to the next writer, and clears the failure", async () => {
    const expired = new Date(NOW.getTime() - CLAIM_LEASE_MS - 1000).toISOString();
    const db = new FakeDb({
      calendar_entries: [
        entry({ draft_claimed_at: NOW.toISOString(), draft_claimed_by: "trial:sub_1", draft_failed_at: NOW.toISOString(), draft_failure: "provider timeout" }),
        entry({ id: "e2", draft_claimed_at: expired, draft_claimed_by: "trial:sub_1" }),
        entry({ id: "e3", draft_claimed_at: NOW.toISOString(), draft_claimed_by: "trial:sub_1" }),
      ],
    });
    expect(await claimEntry(db.client, "e1", "cron:9", { now: NOW })).toBe(true);
    expect(db.rows("calendar_entries")[0]).toMatchObject({ draft_claimed_by: "cron:9", draft_failed_at: null, draft_failure: null });
    expect(await claimEntry(db.client, "e2", "cron:9", { now: NOW })).toBe(true);
    // Somebody is writing e3 right now.
    expect(await claimEntry(db.client, "e3", "cron:9", { now: NOW })).toBe(false);
  });

  it("claims only never-claimed entries for the trial resume, so a redelivered event takes nothing back", async () => {
    const db = new FakeDb({
      calendar_entries: [entry({ draft_claimed_at: NOW.toISOString(), draft_claimed_by: "trial:sub_1", draft_failed_at: NOW.toISOString() })],
    });
    expect(await claimEntry(db.client, "e1", "trial:sub_1", { fresh: true, now: NOW })).toBe(false);
  });
});

describe("recording what happened to a claim", () => {
  it("lets only the claim's own writer record a failure or release it", async () => {
    const db = new FakeDb({ calendar_entries: [entry({ draft_claimed_at: NOW.toISOString(), draft_claimed_by: "cron:2" })] });
    await recordEntryFailure(db.client, "e1", "trial:sub_1", "late failure from a lost lease", NOW);
    expect(db.rows("calendar_entries")[0].draft_failed_at).toBeNull();
    await releaseClaim(db.client, "e1", "trial:sub_1");
    expect(db.rows("calendar_entries")[0].draft_claimed_by).toBe("cron:2");

    await recordEntryFailure(db.client, "e1", "cron:2", "The model timed out.", NOW);
    expect(db.rows("calendar_entries")[0]).toMatchObject({ draft_failed_at: NOW.toISOString(), draft_failure: "The model timed out." });
  });

  it("writes a spend refusal on unclaimed entries only, and keeps them unclaimed", async () => {
    const db = new FakeDb({ calendar_entries: [entry(), entry({ id: "e2", draft_claimed_at: NOW.toISOString(), draft_claimed_by: "cron:1" })] });
    await recordUnclaimedFailure(db.client, ["e1", "e2"], "The account is paused.", NOW);
    const [e1, e2] = db.rows("calendar_entries");
    expect(e1).toMatchObject({ draft_failure: "The account is paused.", draft_claimed_at: null });
    expect(e2.draft_failure).toBeNull();
  });
});

describe("claimsInFlight", () => {
  it("counts claims inside the lease with no article and no failure, for one site", async () => {
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    const expired = new Date(NOW.getTime() - CLAIM_LEASE_MS - 60_000).toISOString();
    const db = new FakeDb({
      calendar_entries: [
        entry({ id: "a", draft_claimed_at: recent, draft_claimed_by: "x" }),
        entry({ id: "b", draft_claimed_at: recent, draft_claimed_by: "x", draft_failed_at: recent }),
        entry({ id: "c", draft_claimed_at: expired, draft_claimed_by: "x" }),
        entry({ id: "d", draft_claimed_at: recent, draft_claimed_by: "x", article_id: "art" }),
        entry({ id: "e", workspace_id: "other", draft_claimed_at: recent, draft_claimed_by: "x" }),
        entry({ id: "f" }),
      ],
    });
    expect(await claimsInFlight(db.client, "ws1", NOW)).toBe(1);
  });
});
