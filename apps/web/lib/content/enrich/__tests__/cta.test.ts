import { describe, it, expect } from "vitest";
import { addCallToAction } from "../cta";

describe("cta", () => {
  it("appends a section with a heading, one sentence and a link to the domain", () => {
    const { html, added } = addCallToAction("<p>Body.</p>", { domain: "https://www.Example.com/", businessName: "Example Ltd" });
    expect(added).toBe(true);
    expect(html).toContain('<section class="cta"><h2>Learn more about Example Ltd</h2>');
    expect(html).toContain('This article is published by Example Ltd. Visit <a href="https://example.com">example.com</a>.');
    expect(html.indexOf("<section")).toBeGreaterThan(html.indexOf("Body."));
  });

  it("falls back to the host when no business name is known", () => {
    const { html } = addCallToAction("<p>x</p>", { domain: "example.com" });
    expect(html).toContain("Learn more about example.com");
  });

  it("does nothing when disabled, without a domain, or when a CTA exists", () => {
    expect(addCallToAction("<p>x</p>", { enabled: false, domain: "a.com" }).added).toBe(false);
    expect(addCallToAction("<p>x</p>", {}).added).toBe(false);
    const once = addCallToAction("<p>x</p>", { domain: "a.com" }).html;
    expect(addCallToAction(once, { domain: "a.com" }).added).toBe(false);
  });

  it("never states an offer or a price", () => {
    const { html } = addCallToAction("<p>x</p>", { domain: "a.com", businessName: "Acme" });
    expect(html).not.toMatch(/free|trial|demo|€|\$|discount|book/i);
  });
});
