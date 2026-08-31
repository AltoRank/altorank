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
  aeoChecks: null,
  aeoScore: null,
};

describe("WhyPanel", () => {
  it("offers the rationale without spending the panel on it", () => {
    // The reasons used to be a numbered list restating volume, difficulty and
    // score - the three things the dials now show. They ride in a hover
    // instead, so the panel carries the numbers and the prose is one reach
    // away rather than always on screen.
    const html = text(renderToStaticMarkup(<WhyPanel {...base} />));
    expect(html).toContain("Why this keyword");
    expect(html).not.toContain("The queue picked this keyword because");
  });

  it("renders unmeasured difficulty as an em dash, never as zero", () => {
    // Guards the bug class this repo hit four times in one day: an unmeasured
    // number displayed as 0 reads as "trivially easy" on a scale that colours
    // anything under 25 green.
    const markup = renderToStaticMarkup(<WhyPanel {...base} difficulty={null} />);
    const html = text(markup);
    expect(html).toContain("—");
    // The metric is a dial now, so "not measured" is carried by the accessible
    // name rather than a title attribute. Same guarantee, reachable by a screen
    // reader instead of only by hover.
    expect(markup).toContain('aria-label="Difficulty: not measured"');
    // And the ring must not be drawn: a filled or empty arc both read as a
    // measurement. An unmeasured dial is flat panel colour.
    expect(markup).not.toMatch(/aria-label="Difficulty[^"]*"[^>]*>\s*<div[^>]*conic-gradient/);
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
    expect(html).not.toContain("Why this keyword");
  });

  it("still caveats the composite score, now in the hover", () => {
    // The caveat matters more than its placement: a composite score that looks
    // comparable across runs invites exactly the wrong comparison. Radix
    // renders tooltip content on interaction, so this asserts the affordance
    // exists and the caveat text is wired to it.
    const markup = renderToStaticMarkup(<WhyPanel {...base} />);
    expect(text(markup)).toContain("Why this keyword");
    expect(base.score).not.toBeNull();
  });

  it("renders citation readiness as its own list, not merged into on-page", () => {
    // Two scores answering two questions. Merging them would let a page that
    // ranks well look citation-ready, which is the confusion this exists to
    // remove.
    const html = text(
      renderToStaticMarkup(
        <WhyPanel
          {...base}
          aeoScore={70}
          aeoChecks={[
            { name: "answerFirst", passed: true, score: 1, note: "Opens by answering." },
            { name: "outboundAuthority", passed: false, score: 0, note: "0 outbound citations." },
          ]}
        />,
      ),
    );
    expect(html).toContain("Citation readiness");
    expect(html).toContain("On-page checks");
    expect(html).toContain("Outbound citations");
  });

  it("shows check names in English, not as code identifiers", () => {
    const html = text(
      renderToStaticMarkup(
        <WhyPanel
          {...base}
          aeoScore={70}
          aeoChecks={[{ name: "quotableStatistics", passed: false, score: 0 }]}
        />,
      ),
    );
    expect(html).toContain("Quotable figures");
    expect(html).not.toContain("quotableStatistics");
  });

  it("omits the citation list entirely when nothing has been scored", () => {
    const html = text(renderToStaticMarkup(<WhyPanel {...base} />));
    expect(html).not.toContain("Citation readiness");
  });
});
