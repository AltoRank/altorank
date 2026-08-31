import { describe, it, expect } from "vitest";
import { scoreCitationReadiness } from "../aeo-scoring";

// Checks come from the citation-pattern research in the aaron-seo-geo pack:
// definitions, quotable content, authority, structure. Verified first against
// three real generated articles, which scored 51 / 75 / 53 — spread, not
// clustered, which is the property that makes a score worth showing.

const GOOD = `<h1>Widget pricing</h1>
<p>Widget pricing is the amount charged per widget per month, and it ranges from
$9 to $99 depending on volume. Most teams pay $29.</p>
<p>A widget is a small metered unit of work that a vendor bills for monthly,
typically sold in bundles of 100 and metered per call rather than per seat.</p>
<h2>How much does a widget cost?</h2>
<p>Around 40% of vendors publish a rate card.</p>
<h2>Which vendors publish pricing?</h2>
<table><tr><th>Vendor</th><th>Price</th></tr><tr><td>A</td><td>$9</td></tr></table>
<p>See <a href="https://example.com/a">Vendor A pricing ($9)</a> and
<a href="https://example.org/b">the 40% survey</a>.</p>`;

describe("scoreCitationReadiness", () => {
  it("rewards an article built to be quoted", () => {
    const r = scoreCitationReadiness(GOOD, "widget pricing");
    expect(r.score).toBeGreaterThan(70);
  });

  it("fails a preamble that does not answer first", () => {
    const html = `<h1>Widgets</h1><p>${"In today's landscape ".repeat(30)}</p>`;
    const c = scoreCitationReadiness(html, "widget pricing").checks;
    expect(c.find((x) => x.name === "answerFirst")?.passed).toBe(false);
  });

  it("wants a standalone definition, not a passing mention", () => {
    const html = `<h1>X</h1><p>Widget pricing matters.</p>`;
    const c = scoreCitationReadiness(html, "widget pricing").checks;
    expect(c.find((x) => x.name === "definitionBlock")?.passed).toBe(false);
  });

  it("counts question-shaped headings", () => {
    const c = scoreCitationReadiness(GOOD, "widget pricing").checks;
    expect(c.find((x) => x.name === "questionHeadings")?.passed).toBe(true);
  });

  it("credits a table over a plain list", () => {
    const withList = scoreCitationReadiness("<h1>a</h1><ol><li>x</li></ol>", "a");
    const withTable = scoreCitationReadiness("<h1>a</h1><table><tr><td>x</td></tr></table>", "a");
    const l = withList.checks.find((c) => c.name === "comparisonTable")!.score;
    const t = withTable.checks.find((c) => c.name === "comparisonTable")!.score;
    expect(t).toBeGreaterThan(l);
  });

  it("flags figures that carry no source", () => {
    const html = `<h1>a</h1><p>Growth hit 40% and 90% and $20 last year.</p>`;
    const c = scoreCitationReadiness(html, "a").checks;
    expect(c.find((x) => x.name === "sourcedClaims")?.passed).toBe(false);
  });

  it("does NOT punish an article that honestly has no figures", () => {
    // A real draft came back fact-check clean precisely because it refused to
    // invent a statistic. Scoring that 0 would push generation toward
    // fabricating one, which is the exact failure the fact checker exists for.
    const html = `<h1>a</h1><p>There is no published rate card for this.</p>`;
    const c = scoreCitationReadiness(html, "a").checks;
    expect(c.find((x) => x.name === "sourcedClaims")?.passed).toBe(true);
  });

  it("penalises wall-of-text paragraphs", () => {
    const html = `<h1>a</h1><p>${"word ".repeat(200)}</p>`;
    const c = scoreCitationReadiness(html, "a").checks;
    expect(c.find((x) => x.name === "scannableStructure")?.passed).toBe(false);
  });

  it("returns a 0-100 integer", () => {
    const r = scoreCitationReadiness(GOOD, "widget pricing");
    expect(Number.isInteger(r.score)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});
