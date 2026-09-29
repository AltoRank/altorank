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
      context: { runId: "run-1", found: 10, qualified: 2, planned: 1, judged: 4, removed: { buyer_fit: 6, not_editorial: 2 } },
    });
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
