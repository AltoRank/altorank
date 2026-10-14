import { describe, expect, it } from "vitest";
import type { ArticleResearch } from "@/lib/seo/research";
import { conformToOutline, h2sOf, outlineHeadings, outlineOf, outlinePrompt, outlineRules, planOutline, predictedClosing, readOutline, type OutlineInput } from "../outline";

const RESEARCH: ArticleResearch = {
  keyword: "acme booking cost",
  language: "English",
  intent: { intent: "info", confidence: "high", signals: [], lexicon: true },
  competitors: [{ rank: 1, title: "What booking software costs", url: "https://rival.example/cost", domain: "rival.example", description: "", wordCount: 1500 }],
  peopleAlsoAsk: ["How much does booking software cost?", "Is booking software worth it?"],
  aiOverview: null,
  relatedKeywords: [],
  existingPerformance: null,
  adjacentQueries: [],
  recommendedWordCount: 1400,
  wordCountBasis: "test",
  layers: [],
  sourceFigures: [
    { sentence: "Most clinics pay 30 a month.", figures: ["30"], url: "https://stats.example/clinics", domain: "stats.example" },
    { sentence: "Half switch within a year.", figures: ["Half"], url: "https://gov.example/report", domain: "gov.example" },
  ],
};
const INPUT: OutlineInput = {
  keyword: "acme booking cost", angle: "What booking software costs a small clinic", language: "en", research: RESEARCH,
  articleType: "guide", articleSubtype: "explainer", targetWordCount: 1400, domain: "acme-clinic.example", site: { name: "Acme Clinic" },
};
const reply = (o: Record<string, unknown>) => async () => JSON.stringify(o);

describe("planOutline", () => {
  it("takes the model's sections and puts the code's own headings around them", async () => {
    const asked: string[] = [];
    const outline = await planOutline(INPUT, {
      ask: async (_op, prompt, opts) => {
        asked.push(prompt);
        expect(opts).toMatchObject({ tier: "decision", schema: expect.any(Object) });
        return JSON.stringify({
          title: "Acme booking cost: what a small clinic pays",
          summaryHeading: "TL;DR",
          sections: ["What does booking software cost?", "What changes the price", "Is it worth it for a clinic?"],
          faqHeading: "Questions",
          sources: ["https://stats.example/clinics", "https://invented.example/x"],
        });
      },
    });
    expect(outline).not.toBeNull();
    // The locale's own labels, not the model's, for the summary and the FAQ.
    expect(outline!.sections).toEqual(["Key takeaways", "What does booking software cost?", "What changes the price", "Is it worth it for a clinic?", "Frequently asked questions"]);
    // The closing call to action enrichment adds, predicted by its rules.
    expect(outline!.closing).toBe("Learn more about Acme Clinic");
    expect(outlineHeadings(outline!)).toHaveLength(6);
    // Only sources research offered; an invented one is dropped.
    expect(outline!.sources).toEqual(["https://stats.example/clinics"]);
    expect(outline!.targetWordCount).toBe(1400);
    expect(asked[0]).toContain("OFFERED SOURCES");
    expect(asked[0]).toContain("acme booking cost");
  });

  it("is null when the model gives nothing usable: the article is written the old way", async () => {
    expect(await planOutline(INPUT, { ask: async () => null })).toBeNull();
    expect(await planOutline(INPUT, { ask: reply({ title: "x", summaryHeading: "", sections: ["only one"], faqHeading: "", sources: [] }) })).toBeNull();
  });

  it("has no FAQ heading when the results page asks fewer than two questions", async () => {
    const outline = await planOutline({ ...INPUT, research: { ...RESEARCH, peopleAlsoAsk: [] } }, {
      ask: reply({ title: "T", summaryHeading: "", sections: ["A?", "B", "C"], faqHeading: "FAQ", sources: [] }),
    });
    expect(outline!.sections).toEqual(["Key takeaways", "A?", "B", "C"]);
  });

  it("predicts no closing heading in a language the locale contract does not describe, or with the call to action off", () => {
    expect(predictedClosing({ domain: "acme.example", language: "xx" })).toBeNull();
    expect(predictedClosing({ domain: "acme.example", language: "en", enabled: false })).toBeNull();
    expect(predictedClosing({ domain: "acme.example", language: "en" })).toMatch(/acme\.example/);
  });

  it("tells the writer every heading, word for word, in order", () => {
    const rules = outlineRules({ version: 1, title: "T", sections: ["One", "Two"], closing: null, targetWordCount: 900, sources: ["https://s.example"], model: "m", createdAt: "" }).join("\n");
    expect(rules).toMatch(/1\. One\n {2}2\. Two/);
    expect(rules).toContain("no other <h2>");
    expect(rules).toContain("https://s.example");
    expect(outlinePrompt(INPUT, { faq: true, summaryLabel: "Key takeaways", faqLabel: "Frequently asked questions", sources: [] })).toContain('use exactly "Key takeaways"');
  });
});

describe("readOutline", () => {
  it("reads a stored outline back and refuses anything else", () => {
    const stored = { version: 1, title: "T", sections: ["A", "B"], closing: null, targetWordCount: 900, sources: [], model: "m", createdAt: "x" };
    expect(readOutline(stored)).toMatchObject({ title: "T", sections: ["A", "B"] });
    expect(outlineOf({ outline: stored })?.title).toBe("T");
    expect(readOutline({ ...stored, version: 2 })).toBeNull();
    expect(readOutline({ ...stored, sections: [] })).toBeNull();
    expect(outlineOf(null)).toBeNull();
  });
});

describe("conformToOutline", () => {
  const sections = ["Key takeaways", "What does it cost?", "How to choose", "Frequently asked questions"];

  it("leaves a body that followed the outline as it is", () => {
    const html = sections.map((h) => `<h2>${h}</h2><p>x</p>`).join("");
    const held = conformToOutline(html, sections);
    expect(held).toMatchObject({ renamed: 0, demoted: 0, missing: [] });
    expect(h2sOf(held.html)).toEqual(sections);
  });

  it("puts reworded headings back to the outline's words and makes extra H2s H3s, keeping their text", () => {
    const html = "<p>intro</p><h2>Key Takeaways</h2><ul><li>a</li></ul><h2>What does it cost??</h2><p>cost</p><h2>A tangent</h2><p>kept</p><h2>Choosing: how to choose</h2><p>c</p><h2>Frequently Asked Questions</h2><p>q</p>";
    const held = conformToOutline(html, sections);
    expect(held.missing).toEqual([]);
    expect(held.demoted).toBe(1);
    expect(h2sOf(held.html)).toEqual(sections);
    expect(held.html).toContain("<h3>A tangent</h3><p>kept</p>");
  });

  it("reports a section the body never wrote", () => {
    const html = "<h2>Key takeaways</h2><p>x</p><h2>What does it cost?</h2><p>y</p>";
    expect(conformToOutline(html, sections).missing).toEqual(["How to choose", "Frequently asked questions"]);
  });
});
