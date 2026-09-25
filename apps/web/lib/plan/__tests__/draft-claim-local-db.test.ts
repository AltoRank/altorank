// ---------------------------------------------------------------------------
// The claims against Postgres itself, on the local stack only
// ---------------------------------------------------------------------------
//
// draft-claim.test.ts and resume-week.test.ts run on an in-memory fake that
// applies the WHERE of each update. This runs the same calls through PostgREST
// into a real database, which is the only thing that can show a conditional
// UPDATE letting exactly one of many concurrent callers win, and that the
// `or(...)` filters parse the way the code means them.
//
// It needs migration 093 on a local Supabase stack, named by
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment -
// never read from an .env file, and never anything but a loopback host, so a
// checkout whose environment points at a hosted project cannot write to it.
// Without them (or without the migration) it skips itself. It seeds one
// account with invented names and deletes it at the end.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimEntry, claimsInFlight, recordEntryFailure } from "../draft-claim";
import { duePlannedKeyword } from "@/lib/onboarding/plan";
import { claimSiteResume, draftRestOfWeek, oweResume, RESUME_LEASE_MS } from "../resume-week";

function localEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") return null;
  } catch {
    return null;
  }
  return { url, key };
}

async function ready(db: SupabaseClient): Promise<boolean> {
  try {
    const { error } = await db.from("calendar_entries").select("draft_claimed_at, draft_owed_at").limit(1);
    return !error;
  } catch {
    return false;
  }
}

const ENV = localEnv();
const DB = ENV ? createClient(ENV.url, ENV.key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const LIVE = DB ? await ready(DB) : false;

const RUN = `claim-test-${Date.now().toString(36)}`;
let accountId = "";
let workspaceId = "";

describe.skipIf(!LIVE)("draft claims on the local database", () => {
  const db = DB!;

  beforeAll(async () => {
    const { data: account, error: accountError } = await db
      .from("accounts")
      .insert({ name: "Acme Agency (claim test)", slug: RUN })
      .select("id")
      .single();
    if (accountError) throw new Error(accountError.message);
    accountId = account.id as string;
    const { data: ws, error: wsError } = await db
      .from("workspaces")
      .insert({ account_id: accountId, name: "acme-agency.example", domain: "acme-agency.example" })
      .select("id")
      .single();
    if (wsError) throw new Error(wsError.message);
    workspaceId = ws.id as string;
  });

  afterAll(async () => {
    if (workspaceId) await db.from("calendar_entries").delete().eq("workspace_id", workspaceId);
    if (workspaceId) await db.from("workspaces").delete().eq("id", workspaceId);
    if (accountId) await db.from("accounts").delete().eq("id", accountId);
  });

  async function entry(date: string, extra: Record<string, unknown> = {}): Promise<string> {
    const { data, error } = await db
      .from("calendar_entries")
      .insert({ workspace_id: workspaceId, keyword: `topic ${date}`, scheduled_date: date, status: "queue", ...extra })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  it("lets exactly one of twelve concurrent writers win one entry", async () => {
    const id = await entry("2026-09-26");
    const writers = Array.from({ length: 12 }, (_, i) => claimEntry(db, id, i % 2 ? `trial:${RUN}` : `cron:${i}`));
    const wins = await Promise.all(writers);
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await claimsInFlight(db, workspaceId)).toBe(1);
  });

  it("refuses the trial resume's fresh claim on anything claimed before, and hands a failed one to the next scheduled run", async () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    // Dated yesterday and being written right now: not due to anybody else.
    const writing = await entry(day(-1));
    expect(await claimEntry(db, writing, `trial:${RUN}`, { fresh: true })).toBe(true);
    // A redelivered event takes nothing back.
    expect(await claimEntry(db, writing, `trial:${RUN}`, { fresh: true })).toBe(false);
    expect(await duePlannedKeyword(db, workspaceId)).toBeNull();

    // Dated four days out, and its draft failed today.
    const failed = await entry(day(4));
    expect(await claimEntry(db, failed, `trial:${RUN}`, { fresh: true })).toBe(true);
    await recordEntryFailure(db, failed, `trial:${RUN}`, "The model timed out.");
    const { data: row } = await db.from("calendar_entries").select("draft_failure, draft_failed_at").eq("id", failed).single();
    expect(row).toMatchObject({ draft_failure: "The model timed out." });
    // Due to the next scheduled run now, not on its day.
    expect((await duePlannedKeyword(db, workspaceId))?.entryId).toBe(failed);
    // And the scheduled writer can take it back, clearing the failure.
    expect(await claimEntry(db, failed, "cron:next")).toBe(true);
    const { data: after } = await db.from("calendar_entries").select("draft_failure, draft_claimed_by").eq("id", failed).single();
    expect(after).toMatchObject({ draft_failure: null, draft_claimed_by: "cron:next" });
    expect(await claimsInFlight(db, workspaceId)).toBe(3);
  });

  it("sends the rest of the plan's week once through the real queries, and nothing the second time", async () => {
    // A second site, so the entries above do not count.
    const { data: site, error } = await db
      .from("workspaces")
      .insert({ account_id: accountId, name: "second.acme-agency.example", domain: "second.acme-agency.example", auto_generate: true, status: "on" })
      .select("id, account_id, auto_generate, status, auto_generate_weekly_limit, refresh_enabled, refresh_days")
      .single();
    if (error) throw new Error(error.message);
    const siteId = site.id as string;
    try {
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const add = async (offset: number, status = "queue") =>
        (await db.from("calendar_entries").insert({ workspace_id: siteId, keyword: `topic ${offset}`, scheduled_date: day(offset), status }).select("id").single()).data!.id as string;
      // The first article, planned yesterday: the plan's week runs to five days from now.
      await add(-1, "scheduled");
      const week = [await add(0), await add(2), await add(5)];
      const nextWeek = await add(6);

      const sent: Array<Record<string, unknown>> = [];
      const fetchImpl = async (_url: string, init: { body: string }) => (sent.push(JSON.parse(init.body)), new Response("{}", { status: 200 }));
      const deps = { baseUrl: "https://app.example", secret: "local-secret", fetchImpl: fetchImpl as never };
      const first = await draftRestOfWeek(db, site as never, { by: `trial:${RUN}`, ...deps });
      await first.settled;
      expect(sent.map((b) => b.entryId).sort()).toEqual([...week].sort());
      expect(first.week?.until).toBe(day(5));
      const { data: owed } = await db.from("calendar_entries").select("id").eq("workspace_id", siteId).not("draft_owed_at", "is", null);
      expect((owed ?? []).map((r) => r.id).sort()).toEqual([...week].sort());

      const again = await draftRestOfWeek(db, site as never, { by: `trial:${RUN}`, ...deps });
      expect(again.started).toEqual([]);
      expect(sent).toHaveLength(3);
      const { data: later } = await db.from("calendar_entries").select("draft_claimed_at").eq("id", nextWeek).single();
      expect(later?.draft_claimed_at).toBeNull();
    } finally {
      await db.from("calendar_entries").delete().eq("workspace_id", siteId);
      await db.from("workspaces").delete().eq("id", siteId);
    }
  });

  it("hands the scheduled writer an owed entry whatever its date, through the real filter", async () => {
    const { data: site, error } = await db
      .from("workspaces")
      .insert({ account_id: accountId, name: "third.acme-agency.example", domain: "third.acme-agency.example" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const siteId = site.id as string;
    try {
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const { data: row } = await db
        .from("calendar_entries")
        .insert({ workspace_id: siteId, keyword: "topic owed", scheduled_date: day(4), status: "queue" })
        .select("id")
        .single();
      expect(await duePlannedKeyword(db, siteId)).toBeNull();
      await db.from("calendar_entries").update({ draft_owed_at: new Date().toISOString() }).eq("id", row!.id);
      expect((await duePlannedKeyword(db, siteId))?.entryId).toBe(row!.id);
    } finally {
      await db.from("calendar_entries").delete().eq("workspace_id", siteId);
      await db.from("workspaces").delete().eq("id", siteId);
    }
  });

  it("owes a site once per checkout, claims it once, and again only once the claim's lease is out", async () => {
    const key = `sub_${RUN}`;
    expect(await oweResume(db, accountId, key)).toBeGreaterThan(0);
    // A redelivered event changes nothing.
    expect(await oweResume(db, accountId, key)).toBe(0);

    const now = new Date();
    const results = await Promise.all([1, 2, 3, 4].map(() => claimSiteResume(db, workspaceId, key, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimSiteResume(db, workspaceId, key, new Date(now.getTime() + 60_000))).toBe(false);
    // Cut off: never finished, and the lease has run out.
    expect(await claimSiteResume(db, workspaceId, key, new Date(now.getTime() + RESUME_LEASE_MS + 60_000))).toBe(true);

    // Finished: never claimed again for this checkout, whatever the clock says.
    await db.from("workspaces").update({ trial_resumed_at: new Date().toISOString() }).eq("id", workspaceId);
    expect(await claimSiteResume(db, workspaceId, key, new Date(now.getTime() + 10 * RESUME_LEASE_MS))).toBe(false);
    expect(await oweResume(db, accountId, key)).toBe(0);
  });
});
