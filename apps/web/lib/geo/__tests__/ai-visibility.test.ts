import { describe, it, expect } from "vitest";
import { mentionsBrand, toDomain, summariseVisibility, type VisibilityResult } from "../ai-visibility";

const result = (over: Partial<VisibilityResult> = {}): VisibilityResult => ({
  prompt: "best seo tools",
  engine: "chat_gpt",
  model: "gpt-4.1",
  answer: "",
  mentioned: false,
  cited: false,
  citations: [],
  competitorDomains: [],
  fanOutQueries: [],
  costUsd: 0.066,
  ...over,
});

describe("toDomain", () => {
  it("normalises host, dropping www and path", () => {
    expect(toDomain("https://www.Rankability.com/blog/x?a=1")).toBe("rankability.com");
  });

  it("returns empty for an unparseable url rather than throwing", () => {
    expect(toDomain("not a url")).toBe("");
  });
});

describe("mentionsBrand", () => {
  it("finds the brand regardless of case", () => {
    expect(mentionsBrand("Tools like altorank help agencies.", "AltoRank")).toBe(true);
  });

  it("does not fire on a brand embedded inside a longer word", () => {
    // The reason for word boundaries: without them a short brand matches
    // constantly and reports visibility that does not exist.
    expect(mentionsBrand("Altogether that is a good result.", "Alto")).toBe(false);
    expect(mentionsBrand("We use Rankability daily.", "Rank")).toBe(false);
  });

  it("still matches the brand as a standalone word beside others", () => {
    expect(mentionsBrand("Our office is in Palo Alto today.", "Alto")).toBe(true);
  });

  it("matches next to punctuation", () => {
    expect(mentionsBrand("Consider AltoRank, Surfer, and Jasper.", "AltoRank")).toBe(true);
  });

  it("ignores a brand name too short to be meaningful", () => {
    expect(mentionsBrand("anything", "x")).toBe(false);
  });
});

describe("summariseVisibility", () => {
  it("computes mention and citation rates over successful probes", () => {
    const s = summariseVisibility([
      result({ mentioned: true, cited: true }),
      result({ mentioned: true, cited: false }),
      result({ mentioned: false, cited: false }),
      result({ mentioned: false, cited: false }),
    ]);
    expect(s.probesRun).toBe(4);
    expect(s.mentionRate).toBe(50);
    expect(s.citationRate).toBe(25);
  });

  it("excludes failed probes from the rates instead of counting them as absent", () => {
    // Missing data reported as a bad result is the exact class of mistake this
    // codebase keeps having to undo.
    const s = summariseVisibility([
      result({ mentioned: true, cited: true }),
      result({ error: "timeout" }),
    ]);
    expect(s.probesRun).toBe(1);
    expect(s.probesFailed).toBe(1);
    expect(s.mentionRate).toBe(100);
    expect(s.citationRate).toBe(100);
  });

  it("ranks competitors by citation count with share of voice", () => {
    const s = summariseVisibility([
      result({ competitorDomains: ["rankability.com", "arvow.com"] }),
      result({ competitorDomains: ["rankability.com"] }),
    ]);
    expect(s.topCompetitors[0]).toMatchObject({ domain: "rankability.com", citations: 2 });
    expect(s.topCompetitors[0].shareOfVoice).toBeCloseTo(66.7, 0);
    expect(s.topCompetitors[1].shareOfVoice).toBeCloseTo(33.3, 0);
  });

  it("reports zeroes rather than dividing by zero when everything failed", () => {
    const s = summariseVisibility([result({ error: "boom" })]);
    expect(s.probesRun).toBe(0);
    expect(s.mentionRate).toBe(0);
    expect(s.topCompetitors).toEqual([]);
  });

  it("totals cost across all probes, including failed ones that still billed", () => {
    const s = summariseVisibility([result({ costUsd: 0.066 }), result({ costUsd: 0.004 })]);
    expect(s.totalCostUsd).toBeCloseTo(0.07, 3);
  });
});
