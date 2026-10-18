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

  it("ends the stage with what it has when the room drops below one batch's claim mid-stage, five batches in flight: bounded, and nothing asked after the end", async () => {
    // A production first look's shape (2026-10-15): fifteen batches, five at
    // a time, each claimed at about $0.085 and charged about $0.025, with
    // room for a few of them. Each refused batch, and its retry, used to
    // claim and be refused on its own after the room was gone.
    const many = Array.from({ length: MAX_JUDGED * 15 }, (_, i) => `acme phrase ${String(i).padStart(4, "0")}`);
    let refusals = 0;
    let grants = 0;
    const ask = async (_op: string, prompt: string) => {
      let claim;
      try {
        claim = await claimSpend("keyword-research/buyer-fit", 0.0855);
      } catch {
        refusals += 1;
        return null;
      }
      grants += 1;
      await new Promise((r) => setTimeout(r, 5 + (phrasesIn(prompt).length % 7)));
      await claim.settle(0.025);
      return JSON.stringify({ verdicts: phrasesIn(prompt).map((t) => ({ t, s: "solution", r: "test" })) });
    };
    const budget = memoryRunBudget("run-hang", 0.3, {});
    const stage = withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, many, { ask, concurrency: 5 }));
    const out = await Promise.race([stage, new Promise<"hung">((r) => setTimeout(() => r("hung"), 5_000))]);
    expect(out).not.toBe("hung");
    if (out === "hung") return;
    // What was bought is judged, what was not stays out - no verdict made up.
    expect(out.verdicts.size).toBeGreaterThan(0);
    expect(out.verdicts.size).toBeLessThan(many.length);
    expect(out.verdicts.size % MAX_JUDGED).toBe(0);
    expect(budget.state().committedUsd).toBeLessThanOrEqual(0.3 + 1e-9);
    // Once refused with nobody else asking, nothing more is claimed: at most
    // the batches that were in flight at the end are refused, not every
    // batch and retry still to come.
    // About one refusal a settle while the room lasts (a settle frees room
    // for one batch, and one waiter asks again), and the in-flight ones at
    // the end: 14 here, where every waiter asking at every settle was 68.
    expect(refusals).toBeLessThanOrEqual(grants + 5);
    // And nothing goes on asking after the stage has returned.
    const settled = { grants, refusals };
    await new Promise((r) => setTimeout(r, 50));
    expect({ grants, refusals }).toEqual(settled);
  });

  it("gives the room a settle frees to the best batch waiting for it, not to a fresh batch whose claim lands first", async () => {
    // The first batch's claims always reach the budget a moment after the
    // others', as a slow database round trip did under load: refused at the
    // start with the room held, it used to lose the room every settle freed
    // to the batch started in the same slot, and ended unjudged while the
    // weakest batches were judged.
    const many = Array.from({ length: MAX_JUDGED * 15 }, (_, i) => `acme phrase ${String(i).padStart(4, "0")}`);
    const ask = async (_op: string, prompt: string) => {
      const phrases = phrasesIn(prompt);
      if (phrases.includes(many[0])) await new Promise((r) => setTimeout(r, 2));
      const claim = await claimSpend("keyword-research/buyer-fit", 0.0855).catch(() => null);
      if (!claim) return null;
      await new Promise((r) => setTimeout(r, 6));
      await claim.settle(0.025);
      return JSON.stringify({ verdicts: phrases.map((t) => ({ t, s: "solution", r: "test" })) });
    };
    const budget = memoryRunBudget("run-line", 0.3, {});
    const out = await withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, many, { ask, concurrency: 5, prioritized: true }));
    expect(out.verdicts.size).toBeGreaterThan(0);
    expect(out.verdicts.size).toBeLessThan(many.length);
    // The strongest forty phrases are judged...
    expect(many.slice(0, MAX_JUDGED).every((p) => out.verdicts.has(p))).toBe(true);
    // ...and what the budget left out is the weakest end of the pool, batch by batch.
    const judged = Array.from({ length: 15 }, (_, b) => out.verdicts.has(many[b * MAX_JUDGED]));
    expect(judged).toEqual([...judged].sort((a, b) => Number(b) - Number(a)));
    expect(budget.state().committedUsd).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it("asks a prioritized pool best first, so a budget that ends part-way leaves the weakest phrases out, not the end of the alphabet", async () => {
    // Best first is reverse-alphabetical here: the strongest phrase sorts last.
    const ranked = [...terms].reverse();
    const a = asker({ costUsd: 0.05, chargedUsd: 0.05 });
    const budget = memoryRunBudget("run-p", 0.1, {});
    const out = await withSpendScope({ budget, stage: "buyer_fit" }, () => judgeBuyerFit(business, ranked, { ask: a.ask, concurrency: 1, prioritized: true }));
    expect(out.verdicts.size).toBe(MAX_JUDGED * 2);
    expect([...out.verdicts.keys()].sort()).toEqual(ranked.slice(0, MAX_JUDGED * 2).sort());
    // Each batch is still sorted inside, so its neighbours do not depend on discovery's order.
    for (const batch of a.asked) expect(batch).toEqual([...batch].sort());
  });
});

