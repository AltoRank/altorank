import { describe, expect, it } from "vitest";
import { judgeBuyerFit, MAX_JUDGED } from "../buyer-fit";
import { memoryRunBudget } from "@/lib/billing/run-budget";
import { claimSpend, withSpendScope } from "@/lib/billing/spend-scope";

// The buyer test's batches are asked side by side now (BUYER_FIT_CONCURRENCY),
// and must come out exactly as the one-at-a-time loop's did: the same
// batches, the same answers, merged in the same order. Every request claims
// from the run's budget first, so running them at once cannot spend past it.

const business = { name: "Acme Studio", description: "Acme Studio sells model railway kits.", offerings: ["model railway kits"], audiences: ["railway modellers"] };
const terms = Array.from({ length: MAX_JUDGED * 4 + 7 }, (_, i) => `acme phrase ${String(i).padStart(3, "0")}`);
const phrasesIn = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf("PHRASES") + "PHRASES".length).trim()) as string[];

function asker(opts: { delayMs?: number; costUsd?: number; chargedUsd?: number } = {}) {
  const asked: string[][] = [];
  let inFlight = 0;
  let peak = 0;
  const ask = async (_op: string, prompt: string) => {
    const claim = opts.costUsd ? await claimSpend("keyword-research/buyer-fit", opts.costUsd) : null;
    const phrases = phrasesIn(prompt);
    asked.push(phrases);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 2));
    inFlight -= 1;
    if (claim && opts.chargedUsd !== undefined) await claim.settle(opts.chargedUsd);
    // A stage per phrase; every third one is not offered.
    return JSON.stringify({ verdicts: phrases.map((t, i) => ({ t, s: i % 3 === 0 ? "not_offered" : "solution", r: "test" })) });
  };
  return { ask, asked, peak: () => peak };
}

describe("judgeBuyerFit, batches side by side", () => {
  it("asks the same batches and returns the same verdicts as one at a time", async () => {
    const one = asker();
    const many = asker();
    const sequential = await judgeBuyerFit(business, terms, { ask: one.ask, concurrency: 1 });
    const parallel = await judgeBuyerFit(business, terms, { ask: many.ask });
    expect(many.peak()).toBeGreaterThan(1);
    expect(one.peak()).toBe(1);
    expect([...parallel.verdicts.entries()]).toEqual([...sequential.verdicts.entries()]);
    expect(many.asked.map((b) => b.join("|")).sort()).toEqual(one.asked.map((b) => b.join("|")).sort());
    expect(parallel.verdicts.size).toBe(terms.length);
  });

  it("spends no more than the run's budget allows, however many batches are in flight", async () => {
    const a = asker({ costUsd: 0.05 });
    // Room for three of the five batches.
    const budget = memoryRunBudget("run-x", 0.15, {});
    const out = await withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, terms, { ask: a.ask }).catch((e) => e));
    expect(budget.state().committedUsd).toBeLessThanOrEqual(0.15 + 1e-9);
    // The refused requests were never sent.
    expect(a.asked.length).toBeLessThanOrEqual(3);
    void out;
  });

  it("judges every phrase when the room fits only four of five claims at once: the fifth waits for one to settle", async () => {
    // Claimed at the output ceiling, charged about a third of it, as live.
    const a = asker({ costUsd: 0.088, chargedUsd: 0.026, delayMs: 5 });
    const budget = memoryRunBudget("run-y", 0.4, {});
    const out = await withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, terms, { ask: a.ask }));
    expect(out.verdicts.size).toBe(terms.length);
    // The last batch alphabetically - the one that used to drop out - is in.
    expect(out.verdicts.has(terms[terms.length - 1])).toBe(true);
    expect(budget.state().committedUsd).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  it("still stops at the budget's real end: refused with nobody else asking", async () => {
    const a = asker({ costUsd: 0.088, chargedUsd: 0.088, delayMs: 2 });
    const budget = memoryRunBudget("run-z", 0.2, {});
    const out = await withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, terms, { ask: a.ask }));
    expect(a.asked.length).toBe(2);
    expect(out.verdicts.size).toBe(MAX_JUDGED * 2);
  });
});
