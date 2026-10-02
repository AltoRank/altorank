import { describe, it, expect } from "vitest";
import { FUNNEL_EVENT_SOURCE, planFunnelEvent } from "../funnel-event";
import { buildEventRow } from "@/lib/observability/event";

const WS = "11111111-1111-4111-8111-111111111111";
const ACC = "22222222-2222-4222-8222-222222222222";

describe("planFunnelEvent", () => {
  it("writes the counts, the run and the one-line summary; a plan with topics is a notice", () => {
    const e = planFunnelEvent({
      runId: "run-1", workspaceId: WS, accountId: ACC,
      funnel: { found: 10, removed: { buyer_fit: 6, not_editorial: 2 }, qualified: 2, planned: 1, judged: 4 },
    });
    expect(e).toEqual({
      source: FUNNEL_EVENT_SOURCE, level: "info", workspaceId: WS, accountId: ACC,
      message: "Topic funnel: 10 found: 6 buyer fit, 2 not editorial -> 2 qualified -> 1 planned",
      context: { runId: "run-1", found: 10, qualified: 2, planned: 1, notPlanned: null, judged: 4, removed: { buyer_fit: 6, not_editorial: 2 } },
    });
  });

  it("says where the qualified topics left off the plan went, and the sanitiser keeps every planner stage", () => {
    const notPlanned = { refused: 1, excluded: 1, on_calendar: 1, not_writable: 1, same_as_calendar: 1, same_search: 1, no_room: 1 };
    const e = planFunnelEvent({ runId: "r", workspaceId: WS, funnel: { found: 12, removed: { buyer_fit: 4 }, qualified: 8, planned: 1, notPlanned } });
    expect(e.level).toBe("info");
    expect(e.message).toContain("-> 8 qualified -> 1 planned (not planned: 1 refused, 1 excluded, 1 on calendar, 1 not writable, 1 same as calendar, 1 same search, 1 no room)");
    expect((buildEventRow(e).context as { notPlanned: unknown }).notPlanned).toEqual(notPlanned);
  });

  it("warns when nothing was planned, which is the run someone has to explain", () => {
    const e = planFunnelEvent({ workspaceId: WS, funnel: { found: 3, removed: { not_editorial: 3 }, qualified: 0, planned: 0 } });
    expect(e.level).toBe("warn");
  });

  it("warns, and says so, when the counts do not add up rather than dropping the event", () => {
    const e = planFunnelEvent({ workspaceId: WS, funnel: { found: 5, removed: { buyer_fit: 1 }, qualified: 1, planned: 1 } });
    expect(e.level).toBe("warn");
    expect(e.message).toContain("counts do not add up: 5 found, but 1 removed + 1 qualified = 2");
  });

  it("records a run whose planner read nothing, with the planning phase's reason", () => {
    const e = planFunnelEvent({ runId: "run-2", workspaceId: WS, funnel: null, planningDetail: "Nothing to schedule until there are keywords." });
    expect(e).toMatchObject({ level: "info", message: "The planner read no candidates this run: Nothing to schedule until there are keywords.", context: { runId: "run-2" } });
  });

  it("survives the event row's sanitiser whole: no stage name reads as a secret, and it fits the cap", () => {
    const removed = { buyer_fit: 1, removed_by_person: 1, covered: 1, off_topic: 1, no_demand: 1, out_of_reach: 1, quality: 1, duplicate: 1,
      spend_refused: 1, not_judged: 1, no_profile: 1, no_verdict: 1, provider_error: 1, thin_serp: 1, judge_incomplete: 1,
      existing_page: 1, needs_page: 1, not_editorial: 1 };
    const e = planFunnelEvent({ runId: "r", workspaceId: WS, accountId: ACC, funnel: { found: 19, removed, qualified: 1, planned: 1, judged: 9 } });
    const row = buildEventRow(e);
    expect((row.context as { removed: unknown }).removed).toEqual(removed);
    expect(row.workspace_id).toBe(WS);
  });
});

describe("the first look's spend on the funnel event", () => {
  const spend = {
    ceilingUsd: 1,
    committedUsd: 0.55,
    refused: 2,
    stages: {
      discovery: { committed: 0.2, spent: 0.2, calls: 9, refused: 0 },
      results_pages: { committed: 0.04, spent: 0.02, calls: 10, refused: 0 },
      judge: { committed: 0.29, spent: 0.29, calls: 14, refused: 2 },
      draft: { committed: 0, spent: 0, calls: 0, refused: 0 },
    },
  };

  it("carries spend per stage, the total and the refusals, and says them on the message line", () => {
    const e = planFunnelEvent({ runId: "r", workspaceId: WS, funnel: { found: 4, removed: { buyer_fit: 2 }, qualified: 2, planned: 1 }, spend });
    expect(e.message).toContain("Spent $0.5100 of $1.00 before the draft; 2 paid reads refused by the budget, left not judged");
    expect((e.context as { spend: unknown }).spend).toEqual({
      ceilingUsd: 1,
      spentUsd: 0.51,
      committedUsd: 0.55,
      refused: 2,
      byStage: {
        discovery: { spentUsd: 0.2, calls: 9 },
        results_pages: { spentUsd: 0.02, calls: 10 },
        judge: { spentUsd: 0.29, calls: 14, refused: 2 },
        draft: { spentUsd: 0, calls: 0 },
      },
    });
  });

  it("survives the event row's sanitiser, on a run the planner never read too", () => {
    for (const funnel of [{ found: 4, removed: { buyer_fit: 2 }, qualified: 2, planned: 1 }, null]) {
      const row = buildEventRow(planFunnelEvent({ runId: "r", workspaceId: WS, funnel, spend }));
      expect((row.context as { spend: { byStage: Record<string, unknown> } }).spend.byStage.judge).toEqual({ spentUsd: 0.29, calls: 14, refused: 2 });
    }
  });

  it("says nothing about spend for a run with no budget", () => {
    const e = planFunnelEvent({ runId: "r", workspaceId: WS, funnel: { found: 1, removed: {}, qualified: 1, planned: 1 }, spend: null });
    expect(e.message).not.toContain("Spent");
    expect(e.context).not.toHaveProperty("spend");
  });
});

