import { describe, it, expect } from "vitest";
import { checkAltText, findWeakAltText, altWordCount, MIN_ALT_WORDS } from "../alt-text";

const keyword = "email marketing software";

describe("checkAltText", () => {
  it("passes a sentence that says what the image shows", () => {
    expect(
      checkAltText("Bar chart comparing the monthly price of five email tools for a 5,000-contact list", keyword),
    ).toBeNull();
  });

  it("names a missing alt before anything else", () => {
    expect(checkAltText(null, keyword)).toBe("missing");
    expect(checkAltText(undefined, keyword)).toBe("missing");
    expect(checkAltText("", keyword)).toBe("missing");
    expect(checkAltText("   ", keyword)).toBe("missing");
  });

  it("recognises the keyword alone however it is dressed", () => {
    // What a model writes when told "include the keyword in alt text": the
    // keyword. It passes a has-alt check and helps nobody.
    expect(checkAltText("email marketing software", keyword)).toBe("keyword");
    expect(checkAltText("Email Marketing Software.", keyword)).toBe("keyword");
    expect(checkAltText("email-marketing software", keyword)).toBe("keyword");
    expect(checkAltText("Image of email marketing software", keyword)).toBe("keyword");
    expect(checkAltText("A screenshot showing the email marketing software", keyword)).toBe("keyword");
  });

  it("calls a label short, and only a label", () => {
    expect(checkAltText("A chart", keyword)).toBe("short");
    expect(checkAltText("Dashboard screenshot with open rates", keyword)).toBe("short");
    // Six words is the floor: a subject, a verb and what is in the picture.
    expect(checkAltText("Screenshot showing open rates by campaign", keyword)).toBeNull();
    expect(altWordCount("Screenshot showing open rates by campaign")).toBe(MIN_ALT_WORDS);
  });

  it("reports the keyword problem over the short one when both apply", () => {
    expect(checkAltText("crm", "CRM")).toBe("keyword");
  });

  it("copes with no keyword at all", () => {
    expect(checkAltText("A chart", "")).toBe("short");
    expect(checkAltText("A chart of open rates across six months", "")).toBeNull();
  });

  it("counts words across scripts, not just ASCII", () => {
    expect(checkAltText("Grafico a barre che confronta i prezzi mensili", "email marketing")).toBeNull();
    expect(checkAltText("Grafico a barre", "email marketing")).toBe("short");
  });
});

describe("findWeakAltText", () => {
  it("lists every image that is missing, keyword-only or short, with what it found", () => {
    const html = [
      '<figure><img src="a.png" alt="Bar chart comparing the monthly price of five email tools"></figure>',
      '<img src="b.png" alt="">',
      '<img alt="email marketing software" src="c.png">',
      "<img src='d.png' alt='A chart'>",
      '<img src="e.png">',
    ].join("\n");
    expect(findWeakAltText(html, keyword)).toEqual([
      { src: "b.png", alt: "", problem: "missing" },
      { src: "c.png", alt: "email marketing software", problem: "keyword" },
      { src: "d.png", alt: "A chart", problem: "short" },
      { src: "e.png", alt: "", problem: "missing" },
    ]);
  });

  it("decodes the alt it shows back, and ignores images that are fine", () => {
    const html = '<img src="q.png" alt="Q&amp;A">';
    expect(findWeakAltText(html, keyword)).toEqual([{ src: "q.png", alt: "Q&A", problem: "short" }]);
    expect(findWeakAltText("<p>No images here.</p>", keyword)).toEqual([]);
  });
});
