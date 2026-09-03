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
<h2>Key takeaways</h2>
<ul><li>Widget pricing is metered per call, not per seat.</li>
<li>Fewer than half of vendors publish a rate card.</li></ul>
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

  describe("given the site's domain", () => {
    // The resolver writes internal links as absolute URLs on the workspace
    // domain, and both link checks used to count those as citations. An
    // article whose only links were to its own siblings scored as well-cited
    // and every figure in it counted as sourced.
    const OWN_LINKS = `<h1>a</h1>
<p>Around 40% of vendors publish a rate card, see
<a href="https://www.example.com/blog/rate-cards">our rate card guide</a> and
<a href="https://example.com/blog/pricing">our pricing guide</a>.</p>`;

    it("does not count links to the site itself as outbound citations", () => {
      const without = scoreCitationReadiness(OWN_LINKS, "a").checks;
      const with_ = scoreCitationReadiness(OWN_LINKS, "a", { siteDomain: "example.com" }).checks;
      expect(without.find((c) => c.name === "outboundAuthority")?.passed).toBe(true);
      expect(with_.find((c) => c.name === "outboundAuthority")?.passed).toBe(false);
      expect(with_.find((c) => c.name === "outboundAuthority")?.note).toContain("0 outbound");
    });

    it("does not treat a link to the site itself as a source for a figure", () => {
      const with_ = scoreCitationReadiness(OWN_LINKS, "a", { siteDomain: "example.com" }).checks;
      expect(with_.find((c) => c.name === "sourcedClaims")?.passed).toBe(false);
    });

    it("still credits a real outbound source", () => {
      const html = `<h1>a</h1><p>Around 40% publish a rate card, per
<a href="https://www.gartner.com/report">Gartner</a> and
<a href="https://example.com/blog/x">our guide</a>.</p>
<p>See also <a href="https://litmus.com/x">Litmus</a>.</p>`;
      const c = scoreCitationReadiness(html, "a", { siteDomain: "example.com" }).checks;
      expect(c.find((x) => x.name === "sourcedClaims")?.passed).toBe(true);
      expect(c.find((x) => x.name === "outboundAuthority")?.note).toContain("2 outbound");
    });

    it("never counts a dead anchor or a placeholder as a citation", () => {
      const html = `<h1>a</h1><p>40% <a href="#">here</a> <a href="{{internal-link:x}}">x</a></p>`;
      const c = scoreCitationReadiness(html, "a").checks;
      expect(c.find((x) => x.name === "outboundAuthority")?.note).toContain("0 outbound");
      expect(c.find((x) => x.name === "sourcedClaims")?.passed).toBe(false);
    });
  });

  describe("summary box", () => {
    it("credits a takeaways heading with a list near the top", () => {
      const c = scoreCitationReadiness(GOOD, "widget pricing").checks;
      expect(c.find((x) => x.name === "summaryBox")?.passed).toBe(true);
    });

    it("half-credits the heading without the list, and ignores one buried at the end", () => {
      const heading = "<h1>a</h1><p>x</p><h2>In short</h2><p>prose only</p>";
      expect(scoreCitationReadiness(heading, "a").checks.find((x) => x.name === "summaryBox")?.score).toBe(0.5);
      const buried = "<h1>a</h1><p>x</p><h2>One</h2><p>y</p><h2>Two</h2><p>z</p><h2>Key takeaways</h2><ul><li>q</li></ul>";
      expect(scoreCitationReadiness(buried, "a").checks.find((x) => x.name === "summaryBox")?.score).toBe(0);
    });

    it("accepts a bold lead as the marker, in other languages too", () => {
      const html = "<h1>a</h1><p><strong>Punti chiave</strong></p><ul><li>uno</li></ul>";
      expect(scoreCitationReadiness(html, "a").checks.find((x) => x.name === "summaryBox")?.passed).toBe(true);
    });
  });

  it("wants about one citation per 500 words, two at minimum", () => {
    const links = '<p><a href="https://a.example/1">a</a> <a href="https://b.example/2">b</a></p>';
    const short = `<h1>a</h1><p>${"word ".repeat(300)}</p>${links}`;
    const long = `<h1>a</h1><p>${"word ".repeat(2400)}</p>${links}`;
    const c1 = scoreCitationReadiness(short, "a", { siteDomain: "example.com" }).checks.find((x) => x.name === "outboundAuthority")!;
    const c2 = scoreCitationReadiness(long, "a", { siteDomain: "example.com" }).checks.find((x) => x.name === "outboundAuthority")!;
    expect(c1.passed).toBe(true);
    expect(c2.passed).toBe(false);
    expect(c2.note).toContain("5 wanted");
  });

  it("returns a 0-100 integer", () => {
    const r = scoreCitationReadiness(GOOD, "widget pricing");
    expect(Number.isInteger(r.score)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});
