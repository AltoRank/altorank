import { describe, it, expect, vi } from "vitest";
import { addSectionImages, chooseInsertionPoints } from "../images";
import { ARTICLE, SECTION } from "./fixtures";

const LONG = Array(90).fill("word").join(" ");

describe("images: where they go", () => {
  it("spreads at most `max` images over long sections, never two in a row", () => {
    const sections = Array(6).fill({ body: `<p>${LONG}</p>` });
    const points = chooseInsertionPoints(sections, 3);
    expect(points.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < points.length; i++) expect(points[i] - points[i - 1]).toBeGreaterThanOrEqual(2);
  });

  it("never illustrates a summary, FAQ or takeaways section", () => {
    const sections = [
      { headingText: "Key takeaways", body: `<p>${LONG}</p>` },
      { headingText: "How it works", body: `<p>${LONG}</p>` },
      { headingText: "Frequently asked questions", body: `<p>${LONG}</p>` },
    ];
    expect(chooseInsertionPoints(sections, 3)).toEqual([1]);
  });

  it("uses the heading as caption when the first sentence introduces a list", async () => {
    const html = `<h1>T</h1><p>i</p><h2>Stages</h2><p>The stages are as follows: ${LONG}</p>`;
    const { html: out } = await addSectionImages(html, { produce: async () => "https://cdn.test/s.webp", max: 1 });
    expect(out).toContain("<figcaption>Stages</figcaption>");
  });

  it("skips short sections and sections that already carry a figure", () => {
    const sections = [
      { body: "<p>short</p>" },
      { body: `<p>${LONG}</p><img src="x">` },
      { body: `<p>${LONG}</p>` },
    ];
    expect(chooseInsertionPoints(sections, 3)).toEqual([2]);
  });
});

describe("images: the figures", () => {
  it("inserts a figure before each chosen H2 with descriptive alt text and a caption from the section", async () => {
    const produce = vi.fn(async (_brief, i: number) => `https://cdn.test/${i}.webp`);
    const { html, added } = await addSectionImages(ARTICLE, { produce, max: 3, style: "sketch" });
    expect(added).toBeGreaterThanOrEqual(1);
    expect(produce.mock.calls[0][0]).toMatchObject({ heading: "What a small team actually needs", style: "sketch" });
    expect(produce.mock.calls[0][0].excerpt.length).toBeLessThanOrEqual(300);
    expect(html).toContain('<img src="https://cdn.test/0.webp" alt="Sketch illustrating What a small team actually needs" loading="lazy">');
    expect(html).toMatch(/<\/figure>\n<h2>What a small team actually needs<\/h2>/);
    expect(html).not.toMatch(/alt="image"|alt="https?:/);
  });

  it("stops at the cap and counts only what it inserted", async () => {
    const produce = vi.fn(async () => "https://cdn.test/a.webp");
    const long = Array(8).fill(0).map((_, i) => SECTION(`Section ${i}`, LONG)).join("");
    const { added } = await addSectionImages(`<h1>T</h1><p>i</p>${long}`, { produce, max: 2 });
    expect(added).toBe(2);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("keeps the article and records a warning when the producer throws", async () => {
    const produce = vi.fn(async () => {
      throw new Error("quota");
    });
    const { html, added, warnings } = await addSectionImages(ARTICLE, { produce });
    expect(added).toBe(0);
    expect(html).toBe(ARTICLE);
    expect(warnings[0]).toMatch(/quota/);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("adds nothing when the producer declines", async () => {
    const { added, html } = await addSectionImages(ARTICLE, { produce: async () => null });
    expect(added).toBe(0);
    expect(html).toBe(ARTICLE);
  });
});
