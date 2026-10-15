import { describe, expect, it } from "vitest";
import { CHECK_IMPACT } from "@/lib/audit/agent-readiness";
import { CHECK_META, describeCheckWeights } from "../shape";
import { readinessExplainer } from "@/lib/explainers/readiness";

describe("describeCheckWeights", () => {
  it("states every check's weight from CHECK_IMPACT, highest first", () => {
    const text = describeCheckWeights();
    expect(text.startsWith("AI crawlers allowed 5 points;")).toBe(true);
    expect(text).toContain("machine-readable copy and content signals 1 point each.");
    for (const id of Object.keys(CHECK_META) as (keyof typeof CHECK_META)[]) {
      expect(text).toContain(CHECK_META[id].label.slice(1));
      expect(CHECK_IMPACT[id]).toBeGreaterThan(0);
    }
    // The old severity copy must not come back.
    expect(text).not.toMatch(/\b(high|medium|low)\b/i);
  });
});

describe("readiness explainer", () => {
  const all = [
    readinessExplainer.intro,
    ...readinessExplainer.sections.flatMap((s) => [s.lead, ...s.bullets]),
    ...readinessExplainer.cannotYet,
  ].join("\n");

  /** CHECK_IMPACT is 5/3/3/3/3/2/2/1/1; the copy said "High checks weigh 3, medium 2, low 1". */
  it("explains the score with the impact weights, not the old severity weights", () => {
    expect(all).not.toContain("High checks weigh 3");
    expect(all).not.toMatch(/severity-weighted/i);
    expect(all).toContain(describeCheckWeights());
    for (const [id, w] of Object.entries(CHECK_IMPACT)) expect(all).toContain(`${id} (${w} point`);
  });

  /** The score is written when the site is analysed; no cron re-runs it nightly. */
  it("does not say every nightly analysis records the score", () => {
    expect(all).not.toMatch(/nightly/i);
  });
});
