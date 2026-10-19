// ---------------------------------------------------------------------------
// onboarding.step events, against Postgres itself
// ---------------------------------------------------------------------------
//
// The dedupe is a PostgREST filter on a jsonb path (`context->>step`), which
// only the real database can show works: a step is written once per
// workspace however often the browser says it, another workspace keeps its
// own, and the row carries ids and numbers only. Seeds one account with
// invented names (acme-*.example) and deletes it at the end.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { recordOnboardingStep } from "../step-events";
import { STEP_EVENT_SOURCE } from "../step-names";

const STACK = await connectLocalStack();
const TAG = randomUUID().slice(0, 8);

describe.skipIf(!STACK)("onboarding.step on the local database", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId = "";
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    db = createServiceClient();
    const { data, error } = await db.from("accounts").insert({ name: `Acme steps ${TAG}`, slug: `acme-steps-${TAG}` }).select("id").single();
    if (error || !data) throw new Error(`accounts: ${error?.message}`);
    accountId = data.id as string;
    for (const n of [1, 2]) {
      const { data: ws, error: wsError } = await db
        .from("workspaces")
        .insert({ account_id: accountId, name: `acme-${TAG}-${n}.example`, domain: `acme-${TAG}-${n}.example`, initials: "AC", color: "av-c1" })
        .select("id")
        .single();
      if (wsError || !ws) throw new Error(`workspaces: ${wsError?.message}`);
      workspaceIds.push(ws.id as string);
    }
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    if (workspaceIds.length) await db.from("system_events").delete().in("workspace_id", workspaceIds);
    if (accountId) await db.from("accounts").delete().eq("id", accountId);
  }, 30_000);

  const rows = async (workspaceId: string) => {
    const { data, error } = await db.from("system_events").select("message, context, level").eq("source", STEP_EVENT_SOURCE).eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    return data ?? [];
  };

  it("writes a step once per workspace however often it is said, and keeps another workspace's apart", async () => {
    const [a, b] = workspaceIds;
    const userId = randomUUID();
    expect(await recordOnboardingStep(db, { workspaceId: a, accountId, userId, step: "site_read_finished", ms: 4321.7 })).toBe(true);
    expect(await recordOnboardingStep(db, { workspaceId: a, accountId, userId, step: "site_read_finished", ms: 99 })).toBe(false);
    expect(await recordOnboardingStep(db, { workspaceId: a, accountId, userId, step: "gate_shown", secondsSinceSignup: 151.2 })).toBe(true);
    expect(await recordOnboardingStep(db, { workspaceId: b, accountId, userId, step: "site_read_finished", ms: 10 })).toBe(true);
    const inA = await rows(a);
    expect(inA).toHaveLength(2);
    const read = inA.find((r) => (r.context as { step: string }).step === "site_read_finished")!;
    // The first one stands; ids and numbers only.
    expect(read.context).toEqual({ step: "site_read_finished", userId, ms: 4322 });
    expect(read.level).toBe("info");
    const gate = inA.find((r) => (r.context as { step: string }).step === "gate_shown")!;
    expect(gate.context).toMatchObject({ secondsSinceSignup: 151 });
    expect(await rows(b)).toHaveLength(1);
  });

  it("writes a step once even when six calls race for it", async () => {
    const [, b] = workspaceIds;
    const wrote = await Promise.all(Array.from({ length: 6 }, () => recordOnboardingStep(db, { workspaceId: b, accountId, userId: null, step: "plan_clicked" })));
    expect(wrote.filter(Boolean)).toHaveLength(1);
    const plan = (await rows(b)).filter((r) => (r.context as { step: string }).step === "plan_clicked");
    expect(plan).toHaveLength(1);
  });

  it("keeps a keyed step once per key: two endings are two rows, the same ending twice is one", async () => {
    const [a] = workspaceIds;
    const ending = (e: "writing" | "article") => recordOnboardingStep(db, { workspaceId: a, accountId, userId: null, step: "setup_ending_shown", props: { ending: e } });
    expect(await ending("writing")).toBe(true);
    expect(await ending("writing")).toBe(false);
    expect(await ending("article")).toBe(true);
    const shown = (await rows(a)).filter((r) => (r.context as { step: string }).step === "setup_ending_shown");
    expect(shown.map((r) => (r.context as { ending: string }).ending).sort()).toEqual(["article", "writing"]);
  });
});
