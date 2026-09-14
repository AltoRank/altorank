import { AsyncLocalStorage } from "node:async_hooks";

export type SpendReporter = (entry: { operation: string; costUsd: number | null }) => void;
type Context = { reporter?: SpendReporter | null; budget?: ResearchBudget };
const context = new AsyncLocalStorage<Context>();

export class ResearchBudget {
  readonly deadline: number;
  calls = 0;
  costUsd = 0;
  private readonly parent = context.getStore()?.budget;
  constructor(readonly maxCalls = 30, durationMs = 120_000) {
    // A new stage may tighten its allowance, but cannot restart the request clock.
    this.deadline = Math.min(Date.now() + durationMs, this.parent?.deadline ?? Infinity);
  }
  get exhausted(): boolean { return this.calls >= this.maxCalls || Date.now() >= this.deadline || Boolean(this.parent?.exhausted); }
  reserve(): void {
    if (this.exhausted) throw new ResearchBudgetError();
    this.parent?.reserve();
    this.calls++;
  }
}
export class ResearchBudgetError extends Error {
  constructor() { super("Research reached its request or time limit. The supported results are saved; retry to investigate more."); this.name = "ResearchBudgetError"; }
}
export function withResearchBudget<T>(budget: ResearchBudget, work: () => T): T {
  return context.run({ ...context.getStore(), budget }, work);
}
export function currentResearchBudget(): ResearchBudget | undefined { return context.getStore()?.budget; }
export function withSpendReporter<T>(reporter: SpendReporter | null, work: () => T): T {
  return context.run({ ...context.getStore(), reporter }, work);
}
/** Compatibility for sequential CLI/cron callers; request entry points use run(). */
export function setScopedSpendReporter(reporter: SpendReporter | null): void {
  context.enterWith({ ...context.getStore(), reporter });
}
export function scopedSpendReporter(): SpendReporter | null | undefined { return context.getStore()?.reporter; }
export function providerSignal(timeoutMs = 20_000): AbortSignal {
  const budget = currentResearchBudget();
  budget?.reserve();
  return AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, budget ? budget.deadline - Date.now() : timeoutMs)));
}

export type ProviderIssue = { kind: "authentication" | "balance" | "temporary" | "deadline" | "unavailable"; message: string };
export function providerIssue(error: unknown): ProviderIssue {
  const code = (error as { statusCode?: number } | null)?.statusCode;
  const name = (error as { name?: string } | null)?.name;
  if (error instanceof ResearchBudgetError || name === "TimeoutError" || name === "AbortError") return { kind: "deadline", message: "Research timed out. Retry to complete the missing checks." };
  if (code === 401 || code === 40100) return { kind: "authentication", message: "The search provider could not authenticate. Check its connection before retrying." };
  if (code === 40200 || code === 40201 || code === 40202) return { kind: "balance", message: "The search provider account is unavailable or out of credit. Check its account before retrying." };
  return { kind: "temporary", message: "Search evidence is temporarily unavailable. Retry the missing checks." };
}
