import { describe, expect, it, vi } from "vitest";
import { ResearchBudget, ResearchBudgetError, providerIssue, providerSignal, scopedSpendReporter, withResearchBudget, withSpendReporter } from "../request-context";

describe("research request isolation", () => {
  it("keeps simultaneous workspaces' spend reporters and budgets separate", async () => {
    const a: number[] = [], b: number[] = [];
    const budgets = [new ResearchBudget(2), new ResearchBudget(3)];
    await Promise.all([a,b].map((sink,i) => withSpendReporter((entry) => sink.push(entry.costUsd!), () => withResearchBudget(budgets[i], async () => {
      await new Promise((r) => setTimeout(r, i ? 1 : 5));
      providerSignal(); scopedSpendReporter()?.({ operation: "research", costUsd: i + 1 });
    }))));
    expect(a).toEqual([1]); expect(b).toEqual([2]);
    expect(budgets.map((b) => b.calls)).toEqual([1,1]);
  });
  it("stops before another provider call when request or time limits expire", () => {
    withResearchBudget(new ResearchBudget(1), () => {
      providerSignal(); expect(() => providerSignal()).toThrow(ResearchBudgetError);
    });
    withResearchBudget(new ResearchBudget(10, -1), () => expect(() => providerSignal()).toThrow(ResearchBudgetError));
  });
  it("separates account failures from temporary and deadline failures", () => {
    expect(providerIssue({statusCode:40100}).kind).toBe("authentication");
    expect(providerIssue({statusCode:40200}).kind).toBe("balance");
    expect(providerIssue(new ResearchBudgetError()).kind).toBe("deadline");
    expect(providerIssue(new Error("bad gateway")).kind).toBe("temporary");
  });
});


it("child stages share the request deadline and consume its call allowance", () => {
  vi.useFakeTimers();
  try {
    const parent = new ResearchBudget(2, 200);
    withResearchBudget(parent, () => {
      const discovery = new ResearchBudget(30, 100_000);
      expect(discovery.deadline).toBe(parent.deadline);
      withResearchBudget(discovery, () => providerSignal());
      const qualification = new ResearchBudget(65, 110_000);
      withResearchBudget(qualification, () => providerSignal());
      expect(parent.calls).toBe(2);
      expect(qualification.calls).toBe(1);
      expect(() => withResearchBudget(new ResearchBudget(1, 15_000), () => providerSignal())).toThrow(ResearchBudgetError);
    });
    const timed = new ResearchBudget(100, 20);
    withResearchBudget(timed, () => {
      vi.advanceTimersByTime(20);
      const laterStage = new ResearchBudget(65, 110_000);
      expect(laterStage.exhausted).toBe(true);
      expect(() => withResearchBudget(laterStage, () => providerSignal())).toThrow(ResearchBudgetError);
    });
  } finally { vi.useRealTimers(); }
});
