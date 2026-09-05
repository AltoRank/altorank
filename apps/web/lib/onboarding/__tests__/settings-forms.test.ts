import { describe, it, expect } from "vitest";
import { fillEmptyProfile, EMPTY_PROFILE, type BusinessProfile } from "../business-profile";
import { outputFromRow, DEFAULT_OUTPUT_SETTINGS } from "../output-settings";

const proposed: BusinessProfile = {
  name: "Acme",
  language: "Italian",
  country: "Italy",
  description: "Sells anvils.",
  audiences: ["Cartoon coyotes"],
  competitors: ["rival.com"],
};

describe("Autocomplete with AI fills only what is empty", () => {
  it("fills blanks in the business section and leaves typed values alone", () => {
    const current: BusinessProfile = { ...EMPTY_PROFILE, name: "My name", description: "" };
    const { profile, filled } = fillEmptyProfile(current, proposed, "business");
    expect(profile.name).toBe("My name");
    expect(profile.description).toBe("Sells anvils.");
    expect(profile.language).toBe("Italian");
    expect(filled).toEqual(["language", "country", "description"]);
    // Not this section's fields.
    expect(profile.audiences).toEqual([]);
  });
  it("treats the wizard defaults for language and market as blank", () => {
    const { filled } = fillEmptyProfile(EMPTY_PROFILE, proposed, "business");
    expect(filled).toContain("language");
    expect(filled).toContain("country");
  });
  it("keeps a chosen language even when the proposal differs", () => {
    const current = { ...EMPTY_PROFILE, language: "German" };
    expect(fillEmptyProfile(current, proposed, "business").profile.language).toBe("German");
  });
  it("fills an empty list and never replaces a populated one", () => {
    const current = { ...EMPTY_PROFILE, audiences: ["Mine"] };
    const { profile, filled } = fillEmptyProfile(current, proposed, "audience");
    expect(profile.audiences).toEqual(["Mine"]);
    expect(profile.competitors).toEqual(["rival.com"]);
    expect(filled).toEqual(["competitors"]);
  });
  it("reports nothing filled when there is nothing to fill", () => {
    expect(fillEmptyProfile(proposed, proposed, "business").filled).toEqual([]);
    expect(fillEmptyProfile(proposed, proposed, "audience").filled).toEqual([]);
  });
  it("ignores an empty proposal", () => {
    const { profile, filled } = fillEmptyProfile(EMPTY_PROFILE, { ...EMPTY_PROFILE, language: "", country: "" }, "business");
    expect(filled).toEqual([]);
    expect(profile).toEqual(EMPTY_PROFILE);
  });
});

describe("outputFromRow", () => {
  it("returns the defaults for a site that never saved", () => {
    expect(outputFromRow(null)).toEqual(DEFAULT_OUTPUT_SETTINGS);
  });
  it("maps the row and nulls the prompt to an empty string", () => {
    expect(
      outputFromRow({
        tone: "formal",
        internal_links: 5,
        table_of_contents: false,
        call_to_action: true,
        first_person: true,
        mention_similar_products: false,
        global_article_prompt: null,
      }),
    ).toEqual({
      tone: "formal",
      internalLinks: 5,
      tableOfContents: false,
      callToAction: true,
      firstPerson: true,
      mentionSimilarProducts: false,
      globalArticlePrompt: "",
    });
  });
  it("falls back to the default tone for a value the list does not have", () => {
    expect(outputFromRow({ tone: "shouty", internal_links: 3, table_of_contents: true, call_to_action: true, first_person: false, mention_similar_products: false, global_article_prompt: "x" }).tone).toBe("informative");
  });
});
