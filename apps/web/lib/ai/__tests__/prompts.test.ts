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
