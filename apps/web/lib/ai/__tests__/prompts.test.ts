import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserMessage, refreshLengthBudget } from "../prompts";

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

describe("buildSystemPrompt — rewriting an existing page", () => {
  const existingHtml = "<h1>Old</h1>" + "<p>" + "word ".repeat(1500) + "</p>";
  const refreshOf = { existingHtml, brief: "## Strengthen\n- the opening", url: "https://x/y", title: "Old" };

  it("carries the body, the brief and a length cap that beats the brief", () => {
    const p = buildSystemPrompt({ keyword: "k", refreshOf });
    expect(p).toContain("THIS IS A REWRITE OF AN EXISTING PAGE");
    expect(p).toContain("## Strengthen");
    expect(p).toContain("<h1>Old</h1>");
    // 1,501 words * 1.3, rounded. The first live run without this cap hit the
    // output ceiling at 24,000 tokens and stored nothing.
    expect(p).toContain("stay under 1,951 words");
    expect(p).toContain("This cap wins over the brief");
    expect(p).not.toContain("Target approximately");
  });

  it("asks for a rewrite in the user turn, and a fresh article otherwise", () => {
    expect(buildUserMessage({ keyword: "k", refreshOf })).toMatch(/^Rewrite the existing page/);
    expect(buildUserMessage({ keyword: "k" })).toMatch(/^Write the article now/);
  });

  it("floors the cap so a very short page can still grow", () => {
    expect(refreshLengthBudget("<p>tiny page</p>").max).toBe(900);
  });
});
