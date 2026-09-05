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
