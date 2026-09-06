import { describe, it, expect } from "vitest";
import { parseBrief, briefToText, deterministicBrief, describeEvidence, buildBriefPrompt } from "../brief";
import type { Evidence } from "../types";

const evidence: Evidence = {
  query: "booking software",
  position: 8.4,
  prev_position: null,
  clicks: 12,
  prev_clicks: null,
  impressions: 340,
  ctr: 0.0353,
  expected_ctr: null,
  word_count: 610,
};

describe("parseBrief", () => {
  it("reads clean JSON", () => {
    const b = parseBrief('{"summary":"s","strengthen":["a"],"questions":["q"],"keep":["k"]}');
    expect(b).toEqual({ summary: "s", strengthen: ["a"], questions: ["q"], keep: ["k"] });
  });

  it("tolerates a code fence and prose around the object", () => {
    const b = parseBrief('Here you go:\n```json\n{"summary":"s","strengthen":["a"],"questions":[],"keep":[]}\n```\nThanks');
    expect(b?.summary).toBe("s");
    expect(b?.strengthen).toEqual(["a"]);
  });

  it("drops non-string items and returns null for nothing usable", () => {
    expect(parseBrief('{"strengthen":[1, "", "  ok "]}')?.strengthen).toEqual(["ok"]);
    expect(parseBrief("not json at all")).toBeNull();
    expect(parseBrief('{"keep":["only keep"]}')).toBeNull();
  });
});

describe("deterministicBrief", () => {
  it("writes a plan from the evidence without a model", () => {
    const b = deterministicBrief({
      url: "https://x/y",
      title: "Y",
      opportunity: "almost_there",
      evidence,
      headings: ["Y", "Pricing"],
      wordCount: 610,
    });
    expect(b.summary).toContain("Almost there");
    expect(b.summary).toContain("Position: 8.4");
    expect(b.strengthen.length).toBeGreaterThan(0);
    expect(b.keep.length).toBeGreaterThan(0);
  });

  it("content_gap names the missing heading rule when headings miss the query", () => {
    const b = deterministicBrief({
      url: "https://x/y",
      title: null,
      opportunity: "content_gap",
      evidence: { ...evidence, word_count: 1200 },
      headings: ["Our story", "Pricing"],
      wordCount: 1200,
    });
    expect(b.strengthen.join(" ")).toMatch(/Add an H2/);
    expect(b.strengthen.join(" ")).not.toMatch(/Extend the thin/);
  });
});

describe("describeEvidence", () => {
  it("omits what was not measured rather than printing zeros", () => {
    const lines = describeEvidence({ ...evidence, clicks: null, ctr: null });
    expect(lines.join("\n")).not.toMatch(/Clicks/);
    expect(lines.join("\n")).not.toMatch(/CTR/);
    expect(lines.join("\n")).toMatch(/Impressions, last 28 days: 340/);
  });
});

describe("briefToText / buildBriefPrompt", () => {
  it("renders sections only when they have items", () => {
    const text = briefToText({ summary: "S", strengthen: ["a"], questions: [], keep: ["k"] });
    expect(text).toContain("## Strengthen\n- a");
    expect(text).not.toContain("## Questions");
    expect(text).toContain("## Keep\n- k");
  });

  it("asks for JSON and carries the evidence and headings", () => {
    const { system, user } = buildBriefPrompt({
      url: "https://x/y",
      title: "Y",
      opportunity: "ctr_gap",
      evidence: { ...evidence, position: 2, expected_ctr: 0.15 },
      headings: ["H one"],
      wordCount: 610,
    });
    expect(system).toMatch(/valid JSON/);
    expect(user).toContain("CTR gap");
    expect(user).toContain("15.0% expected");
    expect(user).toContain("- H one");
  });
});
