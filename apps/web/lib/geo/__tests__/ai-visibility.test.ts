import { describe, it, expect } from "vitest";
import {
  classifyAnswer,
  mentionsBrand,
  toDomain,
  summariseVisibility,
  wilsonInterval,
  type VisibilityResult,
} from "../ai-visibility";

const result = (over: Partial<VisibilityResult> = {}): VisibilityResult => ({
  prompt: "best seo tools",
  engine: "chat_gpt",
  model: "gpt-4.1",
  answer: "",
  mentioned: false,
  cited: false,
  citations: [],
  competitorDomains: [],
  brands: [],
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
    expect(mentionsBrand("Tools like altorank help accounts.", "AltoRank")).toBe(true);
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

describe("wilsonInterval", () => {
  it("keeps a real upper bound when nothing was seen", () => {
    // The case that matters most: thirty answers that never name the brand
    // still allow a true rate near ten percent.
    const i = wilsonInterval(0, 30);
    expect(i.low).toBe(0);
    expect(i.high).toBeGreaterThan(10);
    expect(i.high).toBeLessThan(12);
  });

  it("matches the textbook interval for 6 of 30", () => {
    expect(wilsonInterval(6, 30)).toEqual({ low: 9.5, high: 37.3 });
  });

  it("narrows as the sample grows", () => {
    const small = wilsonInterval(3, 30);
    const large = wilsonInterval(30, 300);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it("says nothing is known when nothing was asked", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 100 });
  });
});

describe("classifyAnswer", () => {
  const citation = (url: string) => ({ title: "", url, domain: toDomain(url) });

  it("counts the domain written in the text as a mention", () => {
    const f = classifyAnswer({ answer: "Try altorank.co for drafts.", citations: [], brands: [], brandName: "Acme", brandDomain: "altorank.co" });
    expect(f.mentioned).toBe(true);
  });

  it("cites only the brand's own domain or a subdomain of it", () => {
    const f = classifyAnswer({
      answer: "",
      citations: [citation("https://blog.altorank.co/x"), citation("https://en.wikipedia.org/wiki/SEO")],
      brands: [],
      brandName: "AltoRank",
      brandDomain: "https://www.altorank.co",
    });
    expect(f.cited).toBe(true);
    expect(f.competitorDomains).toEqual(["en.wikipedia.org"]);
  });

  it("drops the brand itself from the brands the answer named", () => {
    const f = classifyAnswer({ answer: "", citations: [], brands: ["AltoRank", "Surfer"], brandName: "altorank", brandDomain: "altorank.co" });
    expect(f.brands).toEqual(["Surfer"]);
  });
});

describe("summariseVisibility brands", () => {
  it("ranks brands by answers, not by cited domains", () => {
    const s = summariseVisibility([
      result({ brands: ["Surfer", "Frase"], competitorDomains: ["en.wikipedia.org"] }),
      result({ brands: ["Surfer"], competitorDomains: ["en.wikipedia.org"] }),
    ]);
    expect(s.topBrands[0]).toEqual({ brand: "Surfer", answers: 2, rate: 100 });
    expect(s.topBrands.map((b) => b.brand)).not.toContain("en.wikipedia.org");
  });

  it("credits a brand seen on one surface when another surface's text names it", () => {
    // Gemini and AI Mode report no entities; their text still names brands.
    const s = summariseVisibility([
      result({ engine: "chat_gpt", brands: ["Frase"] }),
      result({ engine: "google_ai_mode", answer: "Frase and Clearscope both do briefs." }),
    ]);
    expect(s.topBrands.find((b) => b.brand === "Frase")?.answers).toBe(2);
  });

  it("counts one brand once whatever casing each answer reported it in", () => {
    const s = summariseVisibility([result({ brands: ["HubSpot"] }), result({ brands: ["Hubspot"] })]);
    expect(s.topBrands).toEqual([{ brand: "HubSpot", answers: 2, rate: 100 }]);
  });

  it("reports the mention interval with the rate", () => {
    const s = summariseVisibility([result({ mentioned: true }), result(), result(), result()]);
    expect(s.mentionRate).toBe(25);
    expect(s.mentionInterval.low).toBeGreaterThan(0);
    expect(s.mentionInterval.high).toBeLessThan(100);
  });
});
