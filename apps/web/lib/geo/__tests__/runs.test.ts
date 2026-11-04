import { describe, it, expect } from "vitest";
import { closingStatus, dailySlice, planEntry, plannedCount, runSettings, POST_DAYS } from "../runs";

const settings = runSettings({
  prompts: [
    { id: "p1", prompt: "best seo tool for agencies" },
    { id: "p2", prompt: "outrank alternative" },
  ],
  samples: 5,
  languageCode: "en",
  locationCode: 2840,
  brandName: "AltoRank",
  brandDomain: "altorank.co",
});

describe("a sweep's plan", () => {
  it("is prompts x surfaces x samples", () => {
    expect(plannedCount(settings)).toBe(2 * 3 * 5);
  });

  it("asks every prompt on every surface once before any is asked twice", () => {
    // A run cut short is still balanced: each slice is whole samples.
    const first = Array.from({ length: 6 }, (_, i) => planEntry(settings, i));
    expect(first.every((e) => e.sample === 1)).toBe(true);
    expect(new Set(first.map((e) => `${e.promptId}:${e.surface}`)).size).toBe(6);
    expect(planEntry(settings, 6)).toMatchObject({ promptId: "p1", surface: "chat_gpt", sample: 2 });
    expect(planEntry(settings, 29)).toMatchObject({ promptId: "p2", surface: "google_ai_mode", sample: 5 });
  });

  it("is posted over five days, one sample per cell per day at the default", () => {
    expect(dailySlice(plannedCount(settings))).toBe(6);
    expect(dailySlice(plannedCount(settings)) * POST_DAYS).toBeGreaterThanOrEqual(plannedCount(settings));
  });

  it("clamps samples to the column's 1-30 and defaults the locale", () => {
    expect(runSettings({ ...base(), samples: 99 }).samples).toBe(30);
    expect(runSettings({ ...base(), samples: 0 }).samples).toBe(1);
    expect(runSettings({ ...base(), samples: null }).samples).toBe(5);
    expect(runSettings({ ...base(), languageCode: null, locationCode: null })).toMatchObject({ languageCode: "en", locationCode: 2840 });
  });
});

describe("closing a sweep", () => {
  it("is complete at 95% of the plan and partial below it", () => {
    expect(closingStatus(100, 95)).toBe("complete");
    expect(closingStatus(100, 94)).toBe("partial");
    expect(closingStatus(30, 29)).toBe("complete");
    expect(closingStatus(30, 28)).toBe("partial");
  });

  it("never calls an empty plan complete", () => {
    expect(closingStatus(0, 0)).toBe("partial");
  });
});

function base() {
  return {
    prompts: [{ id: "p1", prompt: "x" }],
    samples: 5 as number | null,
    languageCode: "en" as string | null,
    locationCode: 2840 as number | null,
    brandName: "AltoRank",
    brandDomain: "altorank.co",
  };
}
