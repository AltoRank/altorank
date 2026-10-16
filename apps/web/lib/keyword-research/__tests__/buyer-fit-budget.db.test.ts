// ---------------------------------------------------------------------------
// The buyer test against a run budget in Postgres, at a real first look's end
// ---------------------------------------------------------------------------
//
// A production first look (2026-10-15) reached its buyer test with $0.084 of
// room, and every batch claimed about $0.085 (its 8,000-token ceiling) for a
// reply that costs about $0.025: refused, 19 times. This runs the buyer test
// through the real claim and settle functions (migration 106) with the model
// replaced by a stand-in that answers and bills like the real one:
//
// - at that room a batch is now asked (its claim takes what the room has,
//   down to its floor, and the reply is sized to the grant);
// - when the room falls below one batch's claim while five are in flight,
//   the stage returns in bounded time with what it bought, never commits past
//   the ceiling, and asks nothing once the room is gone.
//
// Seeds one account (acme-*.example) and deletes it at the end.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

import { createServiceClient } from "@/lib/supabase/server";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { openRunBudget, readRunBudget } from "@/lib/billing/run-budget";
import { withSpendScope, type SpendStage } from "@/lib/billing/spend-scope";
import { judgeBuyerFit, MAX_JUDGED } from "../buyer-fit";

const STACK = await connectLocalStack();
const TAG = `b20-fit-${randomUUID().slice(0, 8)}`;
const business = { name: "Acme Studio", description: "Acme Studio sells model railway kits and scenery to hobbyists.", offerings: ["model railway kits"], audiences: ["railway modellers"] };
const pool = (n: number) => Array.from({ length: n }, (_, i) => `acme kit idea ${String(i).padStart(4, "0")}`);

/** The model: answers every phrase, after a moment, billing ~$0.025 a full batch. */
function answering(delayMs: (asked: readonly string[]) => number) {
  create.mockImplementation(async (p: { messages: Array<{ content: string }>; max_tokens: number }) => {
    const prompt = p.messages[0].content;
    const asked = JSON.parse(prompt.slice(prompt.lastIndexOf("PHRASES") + "PHRASES".length).trim()) as string[];
    await new Promise((r) => setTimeout(r, delayMs(asked)));
    return {
      content: [{ type: "text", text: JSON.stringify({ verdicts: asked.map((t) => ({ t, s: "solution", r: "a modeller" })) }) }],
      usage: { input_tokens: 1800, output_tokens: 50 * asked.length },
    };
  });
}

/**
 * A number in [0, 1) fixed by the seed and the key, whatever order calls
 * arrive in. One shared sequence handed each reply the next number in the
 * order the calls reached the model, so a few milliseconds of database
 * jitter on a claim reassigned every later delay.
 */
function draw(seed: number, key: string): number {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 0x01000193) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0; x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0; x ^= x >>> 16;
  return x / 4294967296;
}

describe.skipIf(!STACK)("the buyer test on a run budget in the local database", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId = "";
  let workspaceId = "";

  async function budgetAt(committed: Array<[SpendStage, number]>) {
    const { data, error } = await db.from("onboarding_runs").insert({ workspace_id: workspaceId, account_id: accountId }).select("id").single();
    if (error || !data) throw new Error(`onboarding_runs: ${error?.message}`);
    await db.from("onboarding_runs").update({ status: "done" }).eq("id", data.id);
    const budget = (await openRunBudget(db, { runId: data.id as string, workspaceId }))!;
    for (const [stage, usd] of committed) {
      const got = await budget.claim(stage, usd, usd);
      await budget.settle(stage, got!, usd);
    }
    return { budget, runId: data.id as string };
  }

  beforeAll(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    db = createServiceClient();
    const { data, error } = await db.from("accounts").insert({ name: `${TAG} account`, slug: TAG }).select("id").single();
    if (error || !data) throw new Error(`accounts: ${error?.message}`);
    accountId = data.id as string;
    const ws = await db.from("workspaces").insert({ account_id: accountId, name: `acme-${TAG}.example`, domain: `acme-${TAG}.example`, initials: "AC", color: "av-c1" }).select("id").single();
    if (ws.error || !ws.data) throw new Error(`workspaces: ${ws.error?.message}`);
    workspaceId = ws.data.id as string;
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (accountId) await db.from("accounts").delete().eq("id", accountId);
  }, 30_000);

  it("asks a batch with the $0.084 a production first look had left, where every batch was refused", async () => {
    answering(() => 20);
    create.mockClear();
    // Discovery $0.351, the voice $0.011, nine buyer-test batches $0.224: $0.084 of research room.
    const { budget, runId } = await budgetAt([["discovery", 0.351], ["voice", 0.011], ["buyer_fit", 0.224]]);
    expect(await budget.room("buyer_fit")).toBeCloseTo(0.084, 6);
    const out = await withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, pool(MAX_JUDGED * 3), { prioritized: true }));
    expect(create).toHaveBeenCalled();
    expect(out.verdicts.size).toBeGreaterThanOrEqual(MAX_JUDGED);
    const row = (await readRunBudget(db, runId))!;
    expect(row.committedUsd).toBeLessThanOrEqual(1 + 1e-9);
    expect(row.stages.buyer_fit?.calls).toBeGreaterThan(1);
  }, 30_000);

  it("returns with what it bought when the room falls below one batch's claim mid-stage, five batches in flight", async () => {
    // Each reply's delay is the batch's own: its first phrase and how often
    // that batch has been answered, so a retry draws its own.
    const answered = new Map<string, number>();
    answering((asked) => {
      const n = answered.get(asked[0]) ?? 0;
      answered.set(asked[0], n + 1);
      return 50 + draw(7, `${asked[0]}:${n}`) * 400;
    });
    create.mockClear();
    const { budget, runId } = await budgetAt([["discovery", 0.351], ["voice", 0.011]]);
    const phrases = pool(MAX_JUDGED * 15);
    const started = Date.now();
    const stage = withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, phrases, { concurrency: 5, prioritized: true }));
    const out = await Promise.race([stage, new Promise<"hung">((r) => setTimeout(() => r("hung"), 20_000))]);
    expect(out).not.toBe("hung");
    if (out === "hung") return;
    expect(Date.now() - started).toBeLessThan(20_000);
    // Part of the pool judged, the rest left unjudged - the best first, as far as five at a time allows.
    expect(out.verdicts.size).toBeGreaterThan(0);
    expect(out.verdicts.size).toBeLessThan(phrases.length);
    // The strongest batch is always judged, whichever claim reaches the
    // database first: the room a settle frees goes to the best batch waiting.
    expect(out.verdicts.has(phrases[0])).toBe(true);
    const judgedIn = (from: number, to: number) => phrases.slice(from, to).filter((p) => out.verdicts.has(p)).length;
    expect(judgedIn(0, MAX_JUDGED * 5)).toBeGreaterThan(judgedIn(MAX_JUDGED * 10, phrases.length));
    const asked = create.mock.calls.length;
    const row = (await readRunBudget(db, runId))!;
    expect(row.committedUsd).toBeLessThanOrEqual(1 - 0.33 + 1e-6);
    // Refusals while the room lasted, about one a settle, and the batches in flight at the end.
    expect(row.stages.buyer_fit?.refused ?? 0).toBeLessThanOrEqual(asked + 5);
    // Nothing goes on asking after the stage returned.
    await new Promise((r) => setTimeout(r, 600));
    expect(create.mock.calls.length).toBe(asked);
    expect((await readRunBudget(db, runId))!.stages.buyer_fit?.refused).toBe(row.stages.buyer_fit?.refused);
  }, 40_000);
});
