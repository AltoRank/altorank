import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WhyPanel } from "../why-panel";
import type { ScoringCheck } from "@/lib/seo/scoring";

// renderToStaticMarkup rather than a DOM testing library: this repo has no
// jsdom and the panel is pure presentation, so string assertions on the real
// rendered output are enough and add no dependencies.
//
// React escapes text for the DOM, so an apostrophe in a reason arrives as
// &#x27;. Decode before asserting, otherwise the test fails on correct output.
const text = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const checks: ScoringCheck[] = [
  { name: "keywordInTitle", passed: true, score: 1, note: "Present" },
  { name: "keywordDensity", passed: false, score: 0.4, note: "Keyword density: 0.4% (target: 1-3%)" },
  { name: "metaDescription", passed: false, score: 0, note: "No meta description found" },
  { name: "headingHierarchy", passed: true, score: 1, note: "Good heading hierarchy" },
];

const base = {
  reasons: ["High volume for this domain's authority", "No competing article yet", "Commercial intent"],
  score: 72.5,
  volume: 1200,
  difficulty: 31,
  intent: "commercial",
  checks,
  seoScore: 78,
};

describe("WhyPanel", () => {
  it("renders every reason, in order, not just the first", () => {
    // The whole point: reasons[0] already reached the activity log. The
    // reviewer needs all of them, ranked by how much they moved the score.
    const html = text(renderToStaticMarkup(<WhyPanel {...base} />));
    for (const reason of base.reasons) expect(html).toContain(reason);
    const positions = base.reasons.map((r) => html.indexOf(r));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("renders unmeasured difficulty as an em dash, never as zero", () => {
    // Guards the bug class this repo hit four times in one day: an unmeasured
    // number displayed as 0 reads as "trivially easy" on a scale that colours
    // anything under 25 green.
    const html = text(renderToStaticMarkup(<WhyPanel {...base} difficulty={null} />));
    expect(html).toContain("—");
    expect(html).toContain("Not measured");
    // No standalone zero rendered for the difficulty metric.
    expect(html).not.toMatch(/>\s*0\s*</);
  });

  it("puts failing checks before passing ones", () => {
    // Failures are the only checks that can change an approve/reject decision,
    // so they must not be buried under the ones that passed.
    const html = text(renderToStaticMarkup(<WhyPanel {...base} />));
    expect(html.indexOf("No meta description found")).toBeLessThan(
      html.indexOf("Good heading hierarchy"),
    );
  });

  it("counts passed checks honestly", () => {
    const html = text(renderToStaticMarkup(<WhyPanel {...base} />));
    expect(html).toContain("2/4 passed");
  });

  it("says so plainly when there is no recorded rationale", () => {
    // Manual articles and anything predating migration 022. Inventing a
    // rationale here would be worse than admitting there is none.
    const html = text(
      renderToStaticMarkup(<WhyPanel {...base} reasons={null} score={null} />),
    );
    expect(html).toContain("No selection rationale recorded");
    expect(html).not.toContain("Composite score");
  });

  it("does not imply the composite score is comparable across runs", () => {
    const html = text(renderToStaticMarkup(<WhyPanel {...base} />));
    expect(html).toContain("other candidates in the same run");
  });
});
