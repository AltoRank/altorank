import { describe, it, expect } from "vitest";
import { factCheckArticle } from "@/lib/ai/fact-check";
import { figureRules } from "@/lib/ai/prompts";
import { verifyCitedFigures, type PageFetcher } from "../citation-check";
import { aboutTopic, figureSentences } from "../source-figures";
import type { ArticleResearch } from "../research";

// A first draft (2026-10-21, "Soothing cream for diaper rash") quoted a
// consumer magazine's line about its own finances as evidence. The figure is
// on the cited page, so the fact check called it verified. The sentence is
// the one the draft carried; the page around it is invented.

const KEYWORD = "soothing cream for diaper rash";
const CITED = "https://www.consumerreports.org/babies-kids/diaper-rash-creams/";
const OFF_TOPIC = `Consumer Reports notes that "100% of the fees we collect are used to support our nonprofit mission."`;
const ON_TOPIC = "In tests by Consumer Reports, diaper rash creams with 40% zinc oxide cleared redness fastest.";

const PAGE =
  "<html><body><main>" +
  "<p>In our tests, diaper rash creams with 40% zinc oxide cleared redness fastest.</p>" +
  "<p>100% of the fees we collect are used to support our nonprofit mission.</p>" +
  `<p>${"Apply a thin layer at each change and let the skin dry first. ".repeat(12)}</p>` +
  "</main></body></html>";
const serve: PageFetcher = async () => ({ status: 200, body: PAGE });

const article = (sentence: string) => `<p>${sentence} <a href="${CITED}">Consumer Reports</a></p>`;

describe("a figure about something other than the article's subject", () => {
  it("is not about the topic, while a figure about the cream is", () => {
    expect(aboutTopic(OFF_TOPIC, KEYWORD)).toBe(false);
    expect(aboutTopic(ON_TOPIC, KEYWORD)).toBe(true);
    // Plurals and inflections count: the stem, not the word.
    expect(aboutTopic("Rashes clear in 3 days for most babies.", KEYWORD)).toBe(true);
    // Nothing to judge by is not a reason to flag.
    expect(aboutTopic(OFF_TOPIC, null)).toBe(true);
    expect(aboutTopic(OFF_TOPIC, "the best for you")).toBe(true);
  });

  it("is not marked verified because the number is on the cited page", async () => {
    const report = await verifyCitedFigures(factCheckArticle(article(OFF_TOPIC)), { fetcher: serve, topic: KEYWORD });
    const claim = report.claims.find((c) => c.figures.includes("100%"));
    expect(claim?.status).toBe("needs_verification");
    expect(claim?.severity).toBe("medium");
    expect(claim?.note).toContain(`not about ${KEYWORD}`);
    expect(report.verdict).toBe("review");
  });

  it("still verifies an on-topic figure from the same page", async () => {
    const report = await verifyCitedFigures(factCheckArticle(article(ON_TOPIC)), { fetcher: serve, topic: KEYWORD });
    expect(report.claims.map((c) => c.status)).toEqual(["verified"]);
    expect(report.verdict).toBe("clean");
  });

  it("is judged as before when no topic is given", async () => {
    const report = await verifyCitedFigures(factCheckArticle(article(OFF_TOPIC)), { fetcher: serve });
    expect(report.claims.find((c) => c.figures.includes("100%"))?.status).toBe("verified");
  });

  it("is offered to the writer after the page's on-topic figures, not before", () => {
    const markdown = [
      "100% of the fees we collect are used to support our nonprofit mission.",
      "Ratings are based on 4 rounds of lab tests and a survey of 2,000 members.",
      "In our tests, diaper rash creams with 40% zinc oxide cleared redness fastest.",
    ].join("\n");
    const page = { url: CITED, domain: "consumerreports.org" };
    const ranked = figureSentences(markdown, page, "en", KEYWORD);
    expect(ranked[0].sentence).toContain("diaper rash creams");
    // Without the topic, page order: the fees line first, as the draft got it.
    expect(figureSentences(markdown, page, "en")[0].sentence).toContain("fees we collect");
  });

  it("is ruled out in the brief, and fewer than three figures is allowed", () => {
    const research = {
      sourceFigures: [{ sentence: "100% of the fees we collect are used to support our nonprofit mission.", figures: ["100%"], url: CITED, domain: "consumerreports.org" }],
    } as unknown as ArticleResearch;
    const rules = figureRules(research).join("\n");
    expect(rules).toContain("Use up to three");
    expect(rules).toContain("No figure is better than an");
    expect(rules).not.toContain("two or three");
  });
});
