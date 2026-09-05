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

describe("buildSystemPrompt — internal links", () => {
  it("lists the pool and forbids any other same-domain link", () => {
    const p = buildSystemPrompt({
      keyword: "k",
      internalLinkTargets: [{ keyword: "venture building", title: "What venture building is" }],
    });
    expect(p).toContain("INTERNAL LINKS — link to these, and only these:");
    expect(p).toContain('- venture building — "What venture building is"');
    expect(p).toContain("removed before publishing");
  });

  it("says 'do not add any' when the pool is empty or absent", () => {
    // The first example.com draft was written with no pool and no
    // instruction about it; it invented four same-domain paths.
    for (const targets of [[], undefined]) {
      const p = buildSystemPrompt({ keyword: "k", internalLinkTargets: targets });
      expect(p).toContain("INTERNAL LINKS — do not add any.");
      expect(p).not.toContain("link to these, and only these");
    }
  });

  it("does not ask for N placeholders when there is nothing to link to", () => {
    const output = { internalLinks: 3 } as NonNullable<Parameters<typeof buildSystemPrompt>[0]["output"]>;
    expect(buildSystemPrompt({ keyword: "k", output })).not.toContain("Aim for about 3 internal-link");
    expect(
      buildSystemPrompt({ keyword: "k", output, internalLinkTargets: [{ keyword: "a", title: "A" }] }),
    ).toContain("Aim for about 3 internal-link");
    // Zero is a preference that stands on its own.
    const none = { internalLinks: 0 } as typeof output;
    expect(buildSystemPrompt({ keyword: "k", output: none })).toContain("Do not add internal-link placeholders.");
  });
});
