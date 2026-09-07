import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompts";

const answers = [
  { question: "Which open-source SEO tool is a staple in your toolkit?", answer: "Screaming Frog's free tier, every audit." },
];

describe("buildSystemPrompt — the owner's brief", () => {
  it("says nothing about the owner when there is no brief", () => {
    expect(buildSystemPrompt({ keyword: "open source seo tools" })).not.toContain("WHAT THE SITE OWNER TOLD US");
  });

  it("quotes answers verbatim and forbids extending them", () => {
    const p = buildSystemPrompt({ keyword: "open source seo tools", brief: { answers, instructions: "Mention we are Italian." } });
    expect(p).toContain("WHAT THE SITE OWNER TOLD US");
    expect(p).toContain("Screaming Frog's free tier, every audit.");
    expect(p).toContain("Mention we are Italian.");
    expect(p).toContain("do not invent further examples");
  });

  it("names the article shape from the taxonomy", () => {
    const p = buildSystemPrompt({
      keyword: "open source seo tools",
      brief: { answers: [], articleType: "listicle", articleSubtype: "resources" },
    });
    expect(p).toContain("Article shape: List: Resources");
    expect(p).toContain("one H2 per item");
  });

  it("writes to the owner's length band instead of the SERP-derived count", () => {
    const p = buildSystemPrompt({ keyword: "x", brief: { answers: [], expectedLength: "long" } });
    expect(p).toContain("between 2400 and 3200 words");
    expect(p).not.toContain("Target approximately");
  });

  it("lets an explicit target and an auto band fall through to the old rule", () => {
    expect(buildSystemPrompt({ keyword: "x", targetWordCount: 1800, brief: { answers: [], expectedLength: "long" } })).toContain("Target approximately 1800 words");
    expect(buildSystemPrompt({ keyword: "x", brief: { answers: [], expectedLength: "auto" } })).toContain("Target approximately 1500 words");
  });

  it("does not render an unanswered question as experience", () => {
    // The caller filters; the prompt section only exists for answered rows,
    // so a brief with no answers and no instructions renders no section.
    const p = buildSystemPrompt({ keyword: "x", brief: { answers: [] } });
    expect(p).not.toContain("WHAT THE SITE OWNER TOLD US");
  });
});

describe("buildSystemPrompt — the site the article is for", () => {
  const site = {
    name: "AltoRank",
    description: "An SEO content platform with human approval gates before publication.",
    audiences: ["Digital marketing agencies", "WordPress site owners"],
  };

  it("says nothing about the site when there is no profile", () => {
    expect(buildSystemPrompt({ keyword: "x" })).not.toContain("ABOUT THE SITE THIS ARTICLE IS FOR");
    expect(buildSystemPrompt({ keyword: "x", site: { name: " ", description: null } })).not.toContain("ABOUT THE SITE");
  });

  it("briefs the writer on name, description and audiences, and bounds it", () => {
    const p = buildSystemPrompt({ keyword: "x", site });
    expect(p).toContain("ABOUT THE SITE THIS ARTICLE IS FOR:");
    expect(p).toContain("- Name: AltoRank");
    expect(p).toContain("- What it does: An SEO content platform with human approval gates before publication.");
    expect(p).toContain("- Who it serves: Digital marketing agencies; WordPress site owners");
    expect(p).toContain("State nothing about the business beyond what is written here");
  });

  it("puts the site before the owner's brief and the research", () => {
    const p = buildSystemPrompt({ keyword: "x", site, brief: { answers, instructions: "Keep it short." } });
    expect(p.indexOf("ABOUT THE SITE")).toBeLessThan(p.indexOf("WHAT THE SITE OWNER TOLD US"));
  });

  it("attributes answers in the third person when the first person is off", () => {
    const off = buildSystemPrompt({ keyword: "x", site, brief: { answers }, output: { firstPerson: false } });
    expect(off).toContain("attributed to the business by name (AltoRank), in the third person,");
    expect(off).not.toContain('attributed to the site ("we"');
    const on = buildSystemPrompt({ keyword: "x", site, brief: { answers }, output: { firstPerson: true } });
    expect(on).toContain('attributed to the site ("we", "our team", or the business name),');
  });

  it("asks for a FAQ section only when the faq_schema switch is on", () => {
    expect(buildSystemPrompt({ keyword: "x", output: { faq: true } })).toContain("<h2>Frequently asked questions</h2>");
    expect(buildSystemPrompt({ keyword: "x", output: { faq: false } })).not.toContain("Frequently asked questions</h2>");
    expect(buildSystemPrompt({ keyword: "x", output: {} })).not.toContain("Frequently asked questions</h2>");
  });
});
