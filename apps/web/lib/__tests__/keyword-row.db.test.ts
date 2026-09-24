// ---------------------------------------------------------------------------
// The db tier, proven on the smallest thing that needs it
// ---------------------------------------------------------------------------
//
// The unit suite mocks Supabase, which means it can only ever check what the
// code asks the database for, never what the database answers. Whether a row
// survives the constraints, which defaults it comes back with and which rows a
// query returns are Postgres's answers, and the only honest way to test them is
// to ask a real one. This file is the proof that the `db` project can: it goes
// through the app's own service client (the same factory every server action
// and cron uses) to the local stack, writes one keyword and reads it back.
//
// It also checks two things no mock can: that the schema is the one the
// migrations build (a `gsc` source is only legal from migration 090 on), and
// that the unique index on (workspace_id, term) refuses a second copy of a term,
// which every keyword writer relies on instead of checking first.
//
// Every row it creates hangs off one account with a random slug, and deleting
// that account cascades to the rest, so a shared local stack is left exactly as
// it was found.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/server";
import { connectLocalStack } from "./support/local-db";

const STACK = await connectLocalStack();
const TAG = randomUUID().slice(0, 8);

describe.skipIf(!STACK)("a keyword row, through the service client, on the local stack", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId: string;
  let workspaceId: string;

  beforeAll(async () => {
    // Built here, not at collection time: a skipped suite still collects, and
    // without a stack there is no URL to build a client from.
    db = createServiceClient();
    const { data: account, error: accountErr } = await db
      .from("accounts")
      .insert({ name: `DB proof ${TAG}`, slug: `db-proof-${TAG}` })
      .select("id")
      .single();
    if (accountErr || !account) throw new Error(`accounts: ${accountErr?.message}`);
    accountId = account.id as string;

    const { data: workspace, error: wsErr } = await db
      .from("workspaces")
      .insert({
        account_id: accountId,
        name: `DB proof ${TAG}`,
        domain: `db-proof-${TAG}.test`,
        initials: "DB",
        color: "av-c1",
      })
      .select("id")
      .single();
    if (wsErr || !workspace) throw new Error(`workspaces: ${wsErr?.message}`);
    workspaceId = workspace.id as string;
  }, 30_000);

  afterAll(async () => {
    // Accounts cascade to workspaces, and workspaces to keywords.
    if (db && accountId) await db.from("accounts").delete().eq("id", accountId);
  }, 30_000);

  it("writes a keyword and reads the same row back, with the schema's defaults", async () => {
    const term = `db proof keyword ${TAG}`;
    const { data: written, error: writeErr } = await db
      .from("keywords")
      .insert({ workspace_id: workspaceId, term, volume: 90, source: "gsc" })
      .select("id")
      .single();
    expect(writeErr).toBeNull();

    const { data: read, error: readErr } = await db
      .from("keywords")
      .select("id, workspace_id, term, volume, source, status, intent")
      .eq("id", written!.id)
      .single();
    expect(readErr).toBeNull();
    expect(read).toEqual({
      id: written!.id,
      workspace_id: workspaceId,
      term,
      volume: 90,
      source: "gsc",
      // Column defaults from migration 001: the row says "new, informational"
      // until something decides otherwise.
      status: "new",
      intent: "info",
    });
  });

  it("refuses the same term twice in one site", async () => {
    const term = `db proof duplicate ${TAG}`;
    const first = await db.from("keywords").insert({ workspace_id: workspaceId, term });
    expect(first.error).toBeNull();

    const second = await db.from("keywords").insert({ workspace_id: workspaceId, term });
    // 23505 is Postgres's unique_violation: the index answered, not the client.
    expect(second.error?.code).toBe("23505");

    const { data } = await db.from("keywords").select("id").eq("workspace_id", workspaceId).eq("term", term);
    expect(data).toHaveLength(1);
  });
});
