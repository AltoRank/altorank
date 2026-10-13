// ---------------------------------------------------------------------------
// The planner's funnel against Postgres, on the local stack only
// ---------------------------------------------------------------------------
//
// recommend-funnel.test.ts counts on an in-memory fake. This runs the planner
// the onboarding run calls - schedulePlan, with the recommender, the refill,
// the parking and the calendar insert all real - against the local database,
// and holds the funnel to what the database ends up holding: the qualified
// count to the approvals, `planned` to the calendar rows written, the judge's
// refusals to the rows parked with that cause. Then the run's event goes
// through recordEvent into system_events and is read back.
//
// Only the paid edges are faked: the business profile read and the results
// judge. Seeds one account with invented names and deletes it at the end.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const qualify = vi.fn();
vi.mock("@/lib/keyword-research/business-context", async () => {
  const real = await vi.importActual<typeof import("@/lib/keyword-research/business-context")>("@/lib/keyword-research/business-context");
  return { ...real, ensureBusinessProfile: async (_s: unknown, _w: unknown, _d: unknown, business: unknown) => ({ business, inferred: false, missing: null }) };
});
vi.mock("@/lib/keyword-research/opportunity", async () => {
  const real = await vi.importActual<typeof import("@/lib/keyword-research/opportunity")>("@/lib/keyword-research/opportunity");
  return { ...real, qualifyOpportunities: (...a: unknown[]) => qualify(...a) };
});

import { createServiceClient } from "@/lib/supabase/server";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { schedulePlan } from "../plan";
import { recordPlanFunnel, FUNNEL_EVENT_SOURCE } from "../funnel-event";
import { funnelDiscrepancy, totalNotPlanned, type TopicFunnel } from "@/lib/keyword-research/topic-funnel";
import { contextKey, OPPORTUNITY_VERSION, type Opportunity, type OpportunityContext } from "@/lib/keyword-research/opportunity";

const STACK = await connectLocalStack();
const RUN = `funnel-test-${randomUUID().slice(0, 8)}`;
const DOMAIN = `${RUN}.acme-cycles.example`;
const BUSINESS = { name: "Acme Cycles", description: "Acme is a bike repair workshop: servicing, wheel building and brake work.", audiences: ["commuter cyclists"], offerings: ["bike repair"], competitors: [] };

const TERMS: Array<{ term: string; volume: number | null; difficulty: number; verdict?: Pick<Opportunity, "status" | "cause"> }> = [
  { term: "gravel tubeless setup", volume: 210, difficulty: 5, verdict: { status: "qualified" } },
  { term: "disc vs rim brakes", volume: 170, difficulty: 5, verdict: { status: "qualified" } },
  { term: "chain wear checker", volume: 300, difficulty: 5, verdict: { status: "rejected", cause: "not_editorial" } },
  { term: "bike repair shop open weekends", volume: 260, difficulty: 5, verdict: { status: "rejected", cause: "needs_page" } },
  { term: "bike mechanic salary", volume: 150, difficulty: 5, verdict: { status: "rejected", cause: "buyer_mismatch" } },
  // Measured at zero: no demand. (Unmeasured and kept by the buyer test would go to the judge.)
  { term: "bike repair open sundays", volume: 0, difficulty: 5 },
  { term: "bike repair", volume: 40000, difficulty: 95 },
];

describe.skipIf(!STACK)("the planner's funnel on the local database", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId = "";
  let workspaceId = "";
  const idOf = new Map<string, string>();

  beforeAll(async () => {
    db = createServiceClient();
    const { data: account, error: ae } = await db.from("accounts").insert({ name: "Acme Cycles (funnel test)", slug: RUN }).select("id").single();
    if (ae) throw new Error(ae.message);
    accountId = account.id as string;
    const { data: ws, error: we } = await db.from("workspaces").insert({
      account_id: accountId, name: DOMAIN, domain: DOMAIN, language: "en", location_code: 2124, dr: 10,
      business_profile: BUSINESS, auto_generate_weekly_limit: 7,
    }).select("id").single();
    if (we) throw new Error(we.message);
    workspaceId = ws.id as string;
    const { data: rows, error: ke } = await db.from("keywords").insert(TERMS.map((t) => ({
      workspace_id: workspaceId, term: t.term, volume: t.volume, difficulty: t.difficulty, intent: "info", status: "new",
      source: "gap", buyer_fit: { keep: true, reason: "a cyclist", funnel: "buyer" },
    }))).select("id, term");
    if (ke) throw new Error(ke.message);
    for (const r of rows ?? []) idOf.set(r.term as string, r.id as string);
    const verdictOf = new Map(TERMS.map((t) => [t.term, t.verdict]));
    // Saved under the pass's own context, as the real judge saves them, so a
    // second pass reads them back as current verdicts.
    qualify.mockImplementation(async (s: typeof db, w: string, asked: Array<{ id: string; term: string }>, context: OpportunityContext) => {
      const out = new Map<string, Opportunity>();
      for (const c of asked) {
        const v = verdictOf.get(c.term);
        if (!v) continue;
        const o: Opportunity = { version: OPPORTUNITY_VERSION, context: contextKey(context), checkedAt: new Date().toISOString(), reason: "stub", ...v,
          ...(v.status === "qualified" ? {
            organicUrls: [`https://a.example/${c.id}`, `https://b.example/${c.id}`, `https://c.example/${c.id}`],
            evidenceUrls: [`https://a.example/${c.id}`, `https://b.example/${c.id}`],
            audience: "commuter cyclists", buyingJob: "choosing a workshop", offering: "bike repair", angle: c.term, format: "article",
          } : {}) };
        const { error } = await s.from("keywords").update({ opportunity: o }).eq("id", c.id).eq("workspace_id", w);
        if (error) throw new Error(error.message);
        out.set(c.id, o);
      }
      return out;
    });
  });

  afterAll(async () => {
    if (!db) return;
    if (workspaceId) {
      await db.from("system_events").delete().eq("workspace_id", workspaceId);
      await db.from("calendar_entries").delete().eq("workspace_id", workspaceId);
      await db.from("keywords").delete().eq("workspace_id", workspaceId);
      await db.from("workspaces").delete().eq("id", workspaceId);
    }
    if (accountId) await db.from("accounts").delete().eq("id", accountId);
  });

  it("counts what the database ends up holding, and the run's event lands in system_events", async () => {
    const seen: TopicFunnel[] = [];
    const plan = await schedulePlan(db, workspaceId, 7, { maxEntries: 5, qualifyBatches: 4, onFunnel: (f) => seen.push(f) });
    expect(seen).toHaveLength(1);
    const f = seen[0];
    expect(funnelDiscrepancy(f)).toBeNull();
    expect(f.found).toBe(TERMS.length);
    expect(f.qualified).toBe(2);
    expect(f.removed).toMatchObject({ not_editorial: 1, needs_page: 1, buyer_fit: 1, no_demand: 1, out_of_reach: 1 });

    // `planned` is what the calendar holds, whatever the trial hold allowed,
    // and every approval left off is counted at a planner stage.
    const { data: entries } = await db.from("calendar_entries").select("keyword_id").eq("workspace_id", workspaceId);
    expect(f.planned).toBe(plan.length);
    expect(entries ?? []).toHaveLength(plan.length);
    expect(plan.length).toBeGreaterThan(0);
    expect(f.notPlanned).toEqual(plan.length === 2 ? {} : { no_room: 2 - plan.length });

    // Every refusal the judge gave is parked with its cause, and nothing else is.
    const { data: parked } = await db.from("keywords").select("term, opportunity").eq("workspace_id", workspaceId).not("plan_excluded_at", "is", null);
    const causes = (parked ?? []).map((r) => (r.opportunity as { cause?: string }).cause).sort();
    expect(causes).toEqual(["buyer_mismatch", "needs_page", "not_editorial"]);

    await recordPlanFunnel({ runId: RUN, workspaceId, accountId, funnel: f });
    const { data: events, error } = await db.from("system_events").select("level, source, message, context").eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    expect(events).toHaveLength(1);
    expect(events![0]).toMatchObject({ source: FUNNEL_EVENT_SOURCE, level: "info", context: { runId: RUN, found: TERMS.length, qualified: 2, planned: plan.length } });
    expect(events![0].message).toContain(`${TERMS.length} found`);
  });

  it("on a second pass, says the approvals already planned are on the calendar, not lost", async () => {
    const { count: before } = await db.from("calendar_entries").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
    const seen: TopicFunnel[] = [];
    await schedulePlan(db, workspaceId, 7, { mode: "top-up", maxEntries: 5, qualifyBatches: 4, onFunnel: (f) => seen.push(f) });
    const { count: after } = await db.from("calendar_entries").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
    expect(seen).toHaveLength(1);
    const f = seen[0];
    expect(funnelDiscrepancy(f)).toBeNull();
    // Both approvals still count as qualified - their verdicts are current -
    // and both are accounted for as already planned, with nothing new added.
    expect(f.qualified).toBe(2);
    expect(f.planned).toBe(0);
    expect(after).toBe(before);
    expect(f.notPlanned).toEqual({ on_calendar: 2 });
    expect((f.planned ?? 0) + totalNotPlanned(f)).toBe(f.qualified);
  });
});
