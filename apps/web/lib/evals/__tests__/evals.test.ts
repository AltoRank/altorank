import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget, BudgetExceededError, promptKey, Recorder, type ModelClient } from "../recorder";
import { captureSerps, planEvals, runEvals } from "../run";
import { renderMarkdown, scoreDecision, worstDisagreements } from "../score";
import { claimOutcome, topicAgrees } from "../decisions";
import type { Scored } from "../types";

const SAMPLE = path.join(__dirname, "..", "fixtures", "sample");
const rate = { input: 1, output: 5 };
const model = "claude-haiku-4-5-20251001";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "altorank-evals-"));
  cpSync(SAMPLE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A stand-in for the model that answers the way the prompts ask, from what
 * is in them: the buyer test keeps anything but a sign-in, a recipe or a
 * local search, and
 * the results judge approves a page of lists, versus pages or how-tos.
 */
const scripted = vi.fn<ModelClient>(async ({ prompt }) => {
  const usage = { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 120 };
  const phrases = prompt.match(/PHRASES\n(\[[^]*\])$/);
  if (phrases) {
    const terms = JSON.parse(phrases[1]) as string[];
    return { ...usage, text: JSON.stringify(terms.map((t) => ({ t, k: !/login|pasta|near me/.test(t), f: "buy", r: /login|pasta|near me/.test(t) ? "not a buyer" : "a buyer" }))) };
  }
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n{") + 1)) as { query: string; results: Array<{ url: string; title: string }> };
  const titles = data.results.map((r) => r.title).join(" ").toLowerCase();
  const editorial = data.results.filter((r) => /best|vs|alternatives|how to|steps|workflow/i.test(r.title)).map((r) => r.url);
  const pricing = /pricing|plans/.test(titles);
  const shape = /vs|alternatives/.test(titles) ? "comparison" : /how to|steps|workflow/.test(titles) ? "howTo" : "listicle";
  return { ...usage, text: JSON.stringify({
    approve: !pricing && editorial.length >= 2, reason: pricing ? "Vendor pricing pages" : editorial.length >= 2 ? "Editorial results" : "Navigation",
    audience: "founders", buyingJob: "choose a tool", offering: "drafting", angle: `A guide to ${data.query}`,
    format: pricing ? "product" : editorial.length >= 2 ? "article" : "navigation", shape, conversionPath: "https://altorank.co", evidenceUrls: editorial,
  }) };
});

describe("recorder", () => {
  it("keys an answer by model, operation, ceiling and prompt", () => {
    const a = promptKey(model, "op", "prompt", 100);
    expect(a).toBe(promptKey(model, "op", "prompt", 100));
    expect(a).not.toBe(promptKey(model, "op", "prompt ", 100));
    expect(a).not.toBe(promptKey(model, "op", "prompt", 101));
    expect(a).not.toBe(promptKey("other", "op", "prompt", 100));
  });

  it("replays nothing it has not recorded, and says so", async () => {
    const r = new Recorder({ dir, mode: "replay", model, rate, maxUsd: 0 });
    expect(await r.ask("op", "never asked", { maxTokens: 10 })).toBeNull();
    expect(r.misses).toBe(1);
  });

  it("records a live answer once and replays it for free", async () => {
    const client = vi.fn<ModelClient>(async () => ({ text: "answer", inputTokens: 1000, outputTokens: 100 }));
    const live = new Recorder({ dir, mode: "live", model, rate, maxUsd: 1, client });
    expect(await live.ask("op", "question", { maxTokens: 200 })).toBe("answer");
    expect(await live.ask("op", "question", { maxTokens: 200 })).toBe("answer");
    expect(client).toHaveBeenCalledTimes(1);
    expect(live.budget.spentUsd).toBeCloseTo(0.0015);
    const replay = new Recorder({ dir, mode: "replay", model, rate, maxUsd: 0 });
    expect(await replay.ask("op", "question", { maxTokens: 200 })).toBe("answer");
    expect(replay.hits).toBe(1);
  });

  it("refuses a call that could pass the cap before making it", async () => {
    const client = vi.fn<ModelClient>(async () => ({ text: "x", inputTokens: 1, outputTokens: 1 }));
    // 4,000 output tokens at $5/M is $0.02 on its own.
    const r = new Recorder({ dir, mode: "live", model, rate, maxUsd: 0.01, client });
    await expect(r.ask("op", "question", { maxTokens: 4000 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(client).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, "recordings"))).toBe(false);
  });
});

describe("a run over the public sample", () => {
  it("prices a live run without calling anything", async () => {
    const plan = await planEvals({ dir, model, rate, maxUsd: 1 });
    // One buyer-test batch; five results pages go to the model (the sixth is the site's own page).
    expect(plan.calls).toBe(6);
    expect(plan.upperUsd).toBeGreaterThan(plan.typicalUsd);
    expect(scripted).not.toHaveBeenCalled();
  });

  it("records live, then replays the same scores with no calls", async () => {
    scripted.mockClear();
    const live = await runEvals({ dir, mode: "live", model, rate, maxUsd: 1, client: scripted });
    expect(scripted).toHaveBeenCalledTimes(6);
    expect(readdirSync(path.join(dir, "recordings"))).toHaveLength(6);
    scripted.mockClear();
    const replay = await runEvals({ dir, mode: "replay", model, rate, maxUsd: 0 });
    expect(scripted).not.toHaveBeenCalled();
    expect(replay.recorder.misses).toBe(0);
    expect(replay.scores).toEqual(live.scores);

    const by = (d: string) => replay.scores.find((s) => s.decision === d)!;
    expect(by("buyer-fit")).toMatchObject({ n: 8, agreed: 8 });
    const qual = replay.items.filter((i) => i.decision === "qualification");
    expect(Object.fromEntries(qual.map((i) => [i.item, i.predicted]))).toEqual({
      "best ai seo writing tools": "qualified",
      "outrank alternatives": "qualified",
      "seo content approval workflow": "qualified",
      "ai seo software pricing plans": "needs_page",
      "open source seo content tool": "existing_page",
      "altorank login": "not_editorial",
    });
    // A term that is not a buyer search is right to be refused for any reason.
    expect(qual.find((i) => i.item === "altorank login")!.agrees).toBe(true);
    expect(by("qualification").shape).toEqual({ n: 3, agreed: 3 });
    // The pipeline refuses the sign-in at the buyer test, as the planner does.
    expect(replay.items.find((i) => i.decision === "pipeline" && i.item === "altorank login")!.predicted).toBe("buyer_mismatch");
  });

  it("reads the existing page from the results without asking the model", async () => {
    scripted.mockClear();
    await runEvals({ dir, mode: "live", model, rate, maxUsd: 1, client: scripted, only: ["qualification"] });
    const asked = scripted.mock.calls.map(([req]) => req.prompt);
    expect(asked.some((p) => p.includes("open source seo content tool"))).toBe(false);
  });

  it("stops at the cap and still reports what ran", async () => {
    scripted.mockClear();
    // The buyer-test batch alone could cost $0.02 (4,000 output tokens at $5/M).
    const result = await runEvals({ dir, mode: "live", model, rate, maxUsd: 0.01, client: scripted });
    expect(result.stoppedAt).toMatch(/Spend cap reached/);
    expect(scripted).not.toHaveBeenCalled();
    expect(result.recorder.budget.spentUsd).toBe(0);
    expect(result.items.filter((i) => i.decision === "fact-check")).toHaveLength(3);
  });

  it("checks cited pages from stored copies: a figure on the wrong source's page still reads as supported", async () => {
    const result = await runEvals({ dir, mode: "replay", model, rate, maxUsd: 0, only: ["fact-check"] });
    expect(Object.fromEntries(result.items.map((i) => [i.item, i.predicted]))).toEqual({
      "42-percent-via-vendor-blog": "supported", // labelled misattributed: the check cannot see it
      "61-percent-from-survey": "supported",
      "3400-articles": "unsupported",
    });
    expect(result.scores[0]).toMatchObject({ n: 3, agreed: 2 });
  });
});

describe("evidence capture", () => {
  it("buys only the results pages a case lacks, inside the budget", async () => {
    const file = path.join(dir, "cases", "altorank.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.terms[0].serp;
    delete raw.terms[1].serp;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify(raw));
    const fetchSerp = vi.fn(async () => ({ organic: [{ rank: 1, title: "t", url: "https://x.example/a", description: "", domain: "x.example", wordCount: null }], peopleAlsoAsk: [], aiOverview: null }));
    const budget = new Budget(0.005);
    await expect(captureSerps({ dir, budget, costPerPage: 0.004, fetchSerp })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchSerp).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.terms[0].serp.organic).toHaveLength(1);
    expect(saved.terms[1].serp).toBeUndefined();
    expect(saved.terms[6].serp).toBeNull(); // Deliberately without one: never bought.
  });
});

describe("scoring", () => {
  const s = (expected: string, predicted: string, volume = 0): Scored => ({ decision: "qualification", caseId: "c", item: `${expected}-${predicted}-${volume}`, expected, predicted, agrees: topicAgrees(expected, predicted), volume });

  it("builds the confusion matrix, precision and recall", () => {
    const items = [s("qualified", "qualified"), s("qualified", "not_editorial"), s("qualified", "not_editorial"), s("not_editorial", "not_editorial"), s("needs_page", "qualified")];
    const score = scoreDecision("qualification", items);
    expect(score).toMatchObject({ n: 5, agreed: 2, agreement: 0.4 });
    expect(score.matrix.qualified).toEqual({ qualified: 1, not_editorial: 2 });
    const label = (l: string) => score.labels.find((x) => x.label === l)!;
    expect(label("qualified")).toMatchObject({ support: 3, predicted: 2, precision: 0.5, recall: 1 / 3 });
    expect(label("not_editorial")).toMatchObject({ support: 1, predicted: 3, precision: 1 / 3, recall: 1 });
    expect(label("needs_page")).toMatchObject({ support: 1, predicted: 0, precision: null, recall: 0 });
  });

  it("puts a good topic refused first, the most searched first", () => {
    const worst = worstDisagreements([s("needs_page", "qualified", 5000), s("qualified", "not_editorial", 10), s("qualified", "not_editorial", 900), s("qualified", "qualified", 9999)], 10);
    expect(worst.map((w) => w.item)).toEqual(["qualified-not_editorial-900", "qualified-not_editorial-10", "needs_page-qualified-5000"]);
  });

  it("maps citation statuses onto claim labels", () => {
    expect(claimOutcome("verified")).toBe("supported");
    expect(claimOutcome("contradicted")).toBe("unsupported");
    expect(claimOutcome("unsupported")).toBe("unsupported");
    expect(claimOutcome("needs_verification")).toBe("unverified");
    expect(claimOutcome(null)).toBe("not_extracted");
  });

  it("renders a report with the disagreements and their reasons", () => {
    const items = [{ ...s("qualified", "not_editorial", 70), reason: "Not a | buying decision", note: "Guides are editorial" }];
    const md = renderMarkdown({ title: "T", scores: [scoreDecision("qualification", items)], items, meta: { mode: "replay" } });
    expect(md).toContain("**0/1 (0%)**");
    expect(md).toContain("Not a \\| buying decision");
    expect(md).toContain("Guides are editorial");
  });
});
