import { describe, it, expect } from "vitest";
import {
  forecastWorkspace,
  forecastAll,
  jobForOperation,
  measuredRates,
  DEFAULT_RATES,
  TRACK_CAP,
} from "../forecast";

const base = {
  id: "w", domain: "x.test", trackedKeywords: 0, autoGenerate: false, weeklyLimit: null,
  geoTracking: false, enabledPrompts: 0, needsFirstLook: false,
};

describe("forecastWorkspace", () => {
  it("costs nothing but the weekly backlink sync when nothing is switched on", () => {
    const f = forecastWorkspace(base);
    expect(f.monthly.serp).toBe(0);
    expect(f.monthly.generate).toBe(0);
    expect(f.monthly.geo).toBe(0);
    expect(f.monthly.backlinks).toBeCloseTo(0.05 * 4.35, 6);
  });

  it("tracks at the standard-queue rate, daily, capped like the cron", () => {
    const f = forecastWorkspace({ ...base, trackedKeywords: 1000 });
    expect(f.monthly.serp).toBeCloseTo(TRACK_CAP * 0.0006 * 30.4, 6);
  });

  it("uses the cron's default of two drafts a week when the limit is unset", () => {
    const on = forecastWorkspace({ ...base, autoGenerate: true, weeklyLimit: null });
    const per = DEFAULT_RATES.dfsPerArticle + DEFAULT_RATES.modelPerArticle;
    expect(on.monthly.generate).toBeCloseTo(2 * 4.35 * per, 6);
    // Off means off, whatever the limit says.
    expect(forecastWorkspace({ ...base, autoGenerate: false, weeklyLimit: 20 }).monthly.generate).toBe(0);
  });

  it("charges GEO only when opted in AND prompts exist, four engines per prompt", () => {
    expect(forecastWorkspace({ ...base, geoTracking: true, enabledPrompts: 0 }).monthly.geo).toBe(0);
    const f = forecastWorkspace({ ...base, geoTracking: true, enabledPrompts: 10 });
    expect(f.monthly.geo).toBeCloseTo(10 * 4 * 0.066 * 4.35, 6);
  });

  it("reports the first look as a one-off, outside the monthly total", () => {
    const f = forecastWorkspace({ ...base, needsFirstLook: true });
    expect(f.oneOff).toBe(DEFAULT_RATES.firstLook);
    expect(f.total).toBeCloseTo(f.monthly.backlinks, 6);
  });
});

describe("forecastAll", () => {
  it("flags a GEO backlog when opt-ins exceed what one weekly run serves", () => {
    const ws = Array.from({ length: 5 }, (_, i) => ({ ...base, id: String(i), geoTracking: true, enabledPrompts: 1 }));
    expect(forecastAll(ws).geoBacklog).toBe(2);
  });
});

describe("jobForOperation", () => {
  it("routes the queued SERP flow, including its free GETs, to serp", () => {
    expect(jobForOperation("dataforseo", "/serp/google/organic/task_post")).toBe("serp");
    expect(jobForOperation("dataforseo", "/serp/google/organic/tasks_ready")).toBe("serp");
    expect(jobForOperation("dataforseo", "/serp/google/organic/task_get/regular/{id}")).toBe("serp");
  });
  it("routes article research and the model to generate, probes to geo", () => {
    expect(jobForOperation("dataforseo", "/serp/google/organic/live/advanced")).toBe("generate");
    expect(jobForOperation("anthropic", "claude-sonnet-5")).toBe("generate");
    expect(jobForOperation("dataforseo", "/ai_optimization/chat_gpt/llm_responses/live")).toBe("geo");
  });
  it("leaves discovery and on-demand calls unassigned", () => {
    expect(jobForOperation("dataforseo", "/dataforseo_labs/google/ranked_keywords/live")).toBeNull();
    expect(jobForOperation("dataforseo", "/serp/google/organic/live/regular")).toBeNull();
  });
});

describe("measuredRates", () => {
  it("swaps in a unit only after three observations", () => {
    const two = [1, 2].map(() => ({ provider: "dataforseo", operation: "/serp/google/organic/task_get/regular/{id}", costUsd: 0.0009 }));
    expect(measuredRates(two).measured).toEqual([]);
    const three = [...two, two[0]];
    const r = measuredRates(three);
    expect(r.measured).toEqual(["serpQueued"]);
    expect(r.rates.serpQueued).toBeCloseTo(0.0009, 9);
  });

  it("derives the model cost per article from distinct articles, not rows", () => {
    const rows = ["a", "a", "b", "c"].map((id) => ({ provider: "anthropic", operation: "claude-sonnet-5", costUsd: 0.1, articleId: id }));
    const r = measuredRates(rows);
    // 0.4 over three articles.
    expect(r.rates.modelPerArticle).toBeCloseTo(0.4 / 3, 9);
  });
});
