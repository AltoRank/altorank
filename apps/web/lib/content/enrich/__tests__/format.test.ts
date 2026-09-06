import { describe, it, expect } from "vitest";
import {
  ensureHeadingIds,
  opensWithDirectAnswer,
  boldCitableClaims,
  formatExternalLinks,
  ensureAltText,
  upgradeVideoPrivacy,
  applyFormat,
} from "../format";
import { ARTICLE, SECTION } from "./fixtures";

describe("format: heading ids", () => {
  it("gives every H2 and H3 a slug id and keeps existing ids", () => {
    const { html, added } = ensureHeadingIds(
      `<h2 id="keep-me">Kept</h2><p>x</p><h2>Perché scegliere</h2><h3>5 ways to start</h3>`,
    );
    expect(html).toContain('<h2 id="keep-me">Kept</h2>');
    expect(html).toContain('<h2 id="perche-scegliere">');
    expect(html).toContain('<h3 id="s-5-ways-to-start">');
    expect(added).toBe(2);
  });

  it("deduplicates repeated headings", () => {
    const { html } = ensureHeadingIds(`<h2>Pricing</h2><h2>Pricing</h2>`);
    expect(html).toContain('id="pricing"');
    expect(html).toContain('id="pricing-2"');
  });
});

describe("format: direct answer detection", () => {
  it("accepts a short declarative opening sentence", () => {
    expect(opensWithDirectAnswer("<p>A CRM is a shared record of every contact. It replaces the inbox.</p>")).toBe(true);
  });

  it("rejects announcements, questions and a missing paragraph", () => {
    expect(opensWithDirectAnswer("<p>In this section we will look at what a CRM is.</p>")).toBe(false);
    expect(opensWithDirectAnswer("<p>So what is a CRM, really?</p>")).toBe(false);
    expect(opensWithDirectAnswer("<ul><li>a</li></ul>")).toBe(false);
  });

  it("reports the headings that lack one without rewriting anything", async () => {
    const html = SECTION("Good", "The answer is three tools and one habit.") + SECTION("Bad", "Let's dive into the options.");
    const { html: out, findings } = await applyFormat(html);
    expect(findings.directAnswerMissing).toEqual(["Bad"]);
    expect(out).toContain("<p>Let's dive into the options.</p>");
  });
});

describe("format: citable claims", () => {
  it("bolds the one sentence per section that states a number and its source", () => {
    const html = SECTION(
      "Adoption",
      "Most teams try two tools. Adoption reached 61% in 2025, according to a Gartner survey. Nobody likes the third.",
    );
    const { html: out, bolded } = boldCitableClaims(html);
    expect(bolded).toBe(1);
    expect(out).toContain("<strong>Adoption reached 61% in 2025, according to a Gartner survey.</strong> Nobody");
    expect(out).toContain("<p>Most teams try two tools. <strong>");
  });

  it("does not bold a number without a source, or a paragraph already emphasised", () => {
    const none = boldCitableClaims(SECTION("A", "Adoption reached 61% in 2025 and kept rising."));
    expect(none.bolded).toBe(0);
    const already = boldCitableClaims(
      SECTION("B", "<strong>Note.</strong> Adoption reached 61%, according to Gartner."),
    );
    expect(already.bolded).toBe(0);
  });

  it("keeps a link inside the bolded sentence intact", () => {
    const { html } = boldCitableClaims(
      SECTION("C", 'Churn fell to 4%, per <a href="https://example.org/r">the 2025 report</a>. Fine.'),
    );
    expect(html).toContain('<strong>Churn fell to 4%, per <a href="https://example.org/r">the 2025 report</a>.</strong>');
  });
});

describe("format: external links", () => {
  it("adds rel=noopener to external links only and titles bare URLs", async () => {
    const html =
      '<p>See <a href="https://example.org/report">https://example.org/report</a> and <a href="/pricing">pricing</a> ' +
      'and <a href="https://acme.test/x" rel="nofollow">Acme</a>.</p>';
    const { html: out, externalLinks, titledLinks } = await formatExternalLinks(html, {
      siteDomain: "mysite.com",
      fetchTitle: async () => "The 2025 CRM Report",
    });
    expect(externalLinks).toBe(2);
    expect(titledLinks).toBe(1);
    expect(out).toContain('<a href="https://example.org/report" rel="noopener">The 2025 CRM Report</a>');
    expect(out).toContain('<a href="https://acme.test/x" rel="nofollow noopener">Acme</a>');
    expect(out).toContain('<a href="/pricing">pricing</a>');
  });

  it("leaves a bare URL as-is when the title fetch fails or times out", async () => {
    const html = '<p><a href="https://slow.test/">https://slow.test/</a></p>';
    const { html: out, titledLinks } = await formatExternalLinks(html, {
      fetchTitle: async () => {
        throw new Error("timed out");
      },
    });
    expect(titledLinks).toBe(0);
    expect(out).toContain('rel="noopener">https://slow.test/</a>');
  });
});

describe("format: images and video", () => {
  it("fills missing alt text from the caption, then from the section heading", () => {
    const html =
      SECTION("Dashboard tour", '<figure><img src="/a.webp"><figcaption>The weekly view</figcaption></figure>') +
      SECTION("Setup", '<img src="/b.webp" alt="">');
    const { html: out, added } = ensureAltText(html);
    expect(added).toBe(2);
    expect(out).toContain('<img src="/a.webp" alt="The weekly view">');
    expect(out).toContain('<img src="/b.webp" alt="Setup">');
  });

  it("moves youtube.com embeds to the privacy-enhanced host", () => {
    const { html, upgraded } = upgradeVideoPrivacy('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
    expect(upgraded).toBe(1);
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/abc"');
  });

  it("runs the whole pass over a real-shaped article without losing text", async () => {
    const { html, findings } = await applyFormat(ARTICLE, { siteDomain: "example.com" });
    expect(findings.headingIds).toBeGreaterThanOrEqual(4);
    expect(html.replace(/<[^>]+>/g, "").length).toBeGreaterThanOrEqual(ARTICLE.replace(/<[^>]+>/g, "").length - 5);
  });
});
