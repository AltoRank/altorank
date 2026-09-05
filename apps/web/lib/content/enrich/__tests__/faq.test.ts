import { describe, it, expect } from "vitest";
import { buildFaqSchema, hasFaqShape } from "../faq";
import { ARTICLE, SECTION } from "./fixtures";

describe("faq", () => {
  it("builds FAQPage JSON-LD from the question headings under the FAQ section", () => {
    const { schema, count } = buildFaqSchema(ARTICLE);
    expect(count).toBe(3);
    expect(schema?.["@type"]).toBe("FAQPage");
    expect(schema?.mainEntity[0]).toEqual({
      "@type": "Question",
      name: "Do I need a CRM with five people?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes, if more than one person talks to the same customer. The record replaces the hallway conversation.",
      },
    });
  });

  it("accepts three question headings without a FAQ label", () => {
    const html =
      SECTION("What is a CRM?", "A shared record of every contact and conversation.") +
      SECTION("Who needs one?", "Any team where two people talk to the same customer.") +
      SECTION("What does it cost?", "Between nothing and a few hundred a month, by seat.");
    expect(hasFaqShape(html)).toBe(true);
    expect(buildFaqSchema(html).count).toBe(3);
  });

  it("returns nothing for an article with no FAQ shape or with a single question", () => {
    expect(buildFaqSchema(SECTION("Pricing", "x") + SECTION("Setup", "y")).schema).toBeNull();
    expect(buildFaqSchema(SECTION("FAQ", "<h3>Only one?</h3><p>Then it is not a FAQ, it is a heading.</p>")).schema).toBeNull();
  });
});
