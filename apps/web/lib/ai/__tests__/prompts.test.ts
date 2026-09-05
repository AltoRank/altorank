import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompts";

describe("buildSystemPrompt — title length", () => {
  it("tells the writer the 50-60 character budget when it is choosing the title", () => {
    // Every article in the database ran past 60 characters, four past 80,
    // because the scorer measured a rule the brief never stated.
    const p = buildSystemPrompt({ keyword: "email marketing software" });
    expect(p).toContain("between 50 and 60 characters");
    expect(p).toContain("truncates");
  });

  it("does not argue with a title it was handed", () => {
    const p = buildSystemPrompt({
      keyword: "email marketing software",
      title: "A Title Somebody Else Chose That Runs Well Past Sixty Characters",
    });
    expect(p).toContain("Use the following title");
    expect(p).not.toContain("between 50 and 60 characters");
  });
});

describe("buildSystemPrompt — where a citation goes", () => {
  it("tells the writer to link the source inside the sentence that makes the claim", () => {
    // A model "cites" by appending a Sources list; the claim three screens
    // above it carries no link. The audit flags the orphaned URL afterwards,
    // but the brief has to say it first or every draft fails the same way.
    const p = buildSystemPrompt({ keyword: "email marketing software" });
    expect(p).toContain("Put the link in the sentence that makes the claim");
    expect(p).toContain("Do not collect");
    expect(p).toContain("every");
    expect(p).toContain("URL in it must already be linked inline");
  });
});

describe("buildSystemPrompt — alt text", () => {
  it("asks for a descriptive sentence and shows the keyword-only alt it must not write", () => {
    const p = buildSystemPrompt({ keyword: "email marketing software" });
    expect(p).toContain("full sentence describing what the image shows");
    expect(p).toContain("least six words");
    expect(p).toContain('alt="email marketing software" tells a screen reader nothing');
    // The rule must not read as an invitation to make up image URLs.
    expect(p).toContain("Do not invent <img> URLs");
  });
});
