import { describe, expect, it } from "vitest";
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
