import { describe, it, expect } from "vitest";
import { fillEmptyProfile, EMPTY_PROFILE, type BusinessProfile } from "../business-profile";
import {
  outputFromRow,
  outputToRow,
  parseBrandColor,
  parseYouTubeChannel,
  resolveFeaturedImage,
  DEFAULT_OUTPUT_SETTINGS,
} from "../output-settings";

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
        infographics: false,
        video: true,
        emojis: true,
        faq_schema: false,
        image_style: "realistic",
        featured_image_style: "match_body",
        brand_color: "#ABCDEF",
        youtube_channel: "UCabcdefghijklmnopqrstuv",
      }),
    ).toEqual({
      tone: "formal",
      internalLinks: 5,
      tableOfContents: false,
      callToAction: true,
      firstPerson: true,
      mentionSimilarProducts: false,
      globalArticlePrompt: "",
      infographics: false,
      video: true,
      emojis: true,
      faqSchema: false,
      imageStyle: "realistic",
      featuredImageStyle: "match_body",
      brandColor: "#abcdef",
      youtubeChannel: "UCabcdefghijklmnopqrstuv",
    });
  });
  it("defaults the columns a pre-064 row does not have", () => {
    const s = outputFromRow({ tone: "casual", internal_links: 2, table_of_contents: true, call_to_action: false, first_person: false, mention_similar_products: true, global_article_prompt: "x" });
    expect(s).toEqual({
      ...DEFAULT_OUTPUT_SETTINGS,
      tone: "casual",
      internalLinks: 2,
      callToAction: false,
      mentionSimilarProducts: true,
      globalArticlePrompt: "x",
    });
  });
  it("falls back to the default for a value the lists do not have, never rendering an unknown", () => {
    const s = outputFromRow({ tone: "shouty", image_style: "oil", featured_image_style: "realistic", brand_color: "blue", youtube_channel: "my channel" });
    expect(s.tone).toBe("informative");
    expect(s.imageStyle).toBe("sketch");
    expect(s.featuredImageStyle).toBe("title_cover");
    expect(s.brandColor).toBeNull();
    expect(s.youtubeChannel).toBeNull();
  });
});

describe("outputToRow", () => {
  it("writes exactly what outputFromRow will read back", () => {
    const s = { ...DEFAULT_OUTPUT_SETTINGS, brandColor: "#FF0000", youtubeChannel: "https://www.youtube.com/@Acme", globalArticlePrompt: "  be kind  " };
    const row = outputToRow(s);
    expect(row.brand_color).toBe("#ff0000");
    expect(row.youtube_channel).toBe("@Acme");
    expect(row.global_article_prompt).toBe("be kind");
    expect(outputFromRow(row)).toEqual({ ...s, brandColor: "#ff0000", youtubeChannel: "@Acme", globalArticlePrompt: "be kind" });
  });
  it("clamps links and nulls a blank colour and channel", () => {
    const row = outputToRow({ ...DEFAULT_OUTPUT_SETTINGS, internalLinks: 40, brandColor: "", youtubeChannel: "   " });
    expect(row.internal_links).toBe(10);
    expect(row.brand_color).toBeNull();
    expect(row.youtube_channel).toBeNull();
  });
});

describe("parseBrandColor", () => {
  it("accepts six hex digits in either case and nothing else", () => {
    expect(parseBrandColor("#1A1815")).toBe("#1a1815");
    expect(parseBrandColor(" #abcdef ")).toBe("#abcdef");
    expect(parseBrandColor("#abc")).toBeNull();
    expect(parseBrandColor("1a1815")).toBeNull();
    expect(parseBrandColor("red")).toBeNull();
    expect(parseBrandColor(null)).toBeNull();
  });
});

describe("parseYouTubeChannel", () => {
  it("takes an id, a handle or either URL form and stores the id or handle", () => {
    expect(parseYouTubeChannel("UCabcdefghijklmnopqrstuv")).toBe("UCabcdefghijklmnopqrstuv");
    expect(parseYouTubeChannel("@acme")).toBe("@acme");
    expect(parseYouTubeChannel("https://www.youtube.com/@acme")).toBe("@acme");
    expect(parseYouTubeChannel("youtube.com/@acme/videos")).toBe("@acme");
    expect(parseYouTubeChannel("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv?view=0")).toBe("UCabcdefghijklmnopqrstuv");
  });
  it("refuses what the search API could not use", () => {
    expect(parseYouTubeChannel("acme")).toBeNull();
    expect(parseYouTubeChannel("https://www.youtube.com/watch?v=abc")).toBeNull();
    expect(parseYouTubeChannel("UC-too-short")).toBeNull();
    expect(parseYouTubeChannel("")).toBeNull();
  });
});

describe("resolveFeaturedImage", () => {
  it("title cover is type, not a preset; match_body follows the body; the rest are themselves", () => {
    expect(resolveFeaturedImage({ imageStyle: "watercolor", featuredImageStyle: "title_cover" })).toEqual({ style: null, titleCover: true });
    expect(resolveFeaturedImage({ imageStyle: "watercolor", featuredImageStyle: "match_body" })).toEqual({ style: "watercolor", titleCover: false });
    expect(resolveFeaturedImage({ imageStyle: "watercolor", featuredImageStyle: "sketch" })).toEqual({ style: "sketch", titleCover: false });
  });
});
