import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AuditPanel } from "../audit-panel";
import { auditArticle } from "@/lib/seo/article-audit";

const text = (html: string) =>
  html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("AuditPanel", () => {
  const audit = auditArticle({
    html: `
      <h1>Email marketing software</h1>
      <p>Email marketing software sends mail. 42% of teams switch yearly.</p>
      <p>Details on <a href="https://www.litmus.com/x">Litmus</a> and <a href="#">here</a>.</p>
    `,
    keyword: "email marketing software",
    siteDomain: "example.com",
    title: "Email Marketing Software: A Practical Comparison",
    metaDescription: "x".repeat(130),
    slug: "email-marketing-software",
    featuredImageUrl: null,
  });

  it("leads with the verdict and groups the findings", () => {
    const html = text(renderToStaticMarkup(<AuditPanel audit={audit} onLocate={() => {}} />));
    expect(html).toContain("Needs work");
    for (const group of ["Links", "Sources", "Structure", "Metadata", "Media", "Trust signals"]) {
      expect(html).toContain(group);
    }
    expect(html).toContain("Dead links");
    expect(html).toContain("Figures with a linked source");
  });

  it("offers each offending fragment as something to jump to", () => {
    // The dead link's anchor text and the unsourced figure are the two things
    // the reviewer has to go and change; both must be one click away.
    const html = text(renderToStaticMarkup(<AuditPanel audit={audit} onLocate={() => {}} />));
    expect(html).toMatch(/title="Select this in the article"[^>]*>here<\/button>/);
    expect(html).toMatch(/title="Select this in the article"[^>]*>42%<\/button>/);
  });

  it("lists the links it counted, so the count can be checked", () => {
    const html = text(renderToStaticMarkup(<AuditPanel audit={audit} />));
    expect(html).toContain("https://www.litmus.com/x");
    expect(html).toContain(">Litmus<");
  });

  it("does not claim to have verified anything", () => {
    const html = text(renderToStaticMarkup(<AuditPanel audit={audit} />));
    expect(html).toContain("Sources not verified");
    expect(html).toContain("cannot tell whether a cited page exists");
  });
});
