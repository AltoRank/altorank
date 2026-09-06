import { describe, it, expect } from "vitest";
import { addTableOfContents, hasTableOfContents } from "../toc";
import { ARTICLE, SECTION } from "./fixtures";

describe("toc", () => {
  it("adds a flat nav of H2 anchors after the intro paragraph", () => {
    const { html, added } = addTableOfContents(ARTICLE);
    expect(added).toBe(true);
    const nav = html.match(/<nav class="toc"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain('<a href="#what-a-small-team-actually-needs">What a small team actually needs</a>');
    expect((nav.match(/<li>/g) ?? []).length).toBe(4);
    expect(nav).not.toContain("Do I need a CRM"); // H3s stay out
    // Placed after the first intro paragraph and before the first H2.
    expect(html.indexOf("<nav")).toBeGreaterThan(html.indexOf("</p>"));
    expect(html.indexOf("<nav")).toBeLessThan(html.indexOf("<h2"));
  });

  it("uses the same ids the headings carry", () => {
    const { html } = addTableOfContents(ARTICLE);
    for (const id of html.matchAll(/href="#([^"]+)"/g)) {
      expect(html).toContain(`id="${id[1]}"`);
    }
  });

  it("skips when disabled, when there are fewer than three H2s, or when one exists", () => {
    expect(addTableOfContents(ARTICLE, { enabled: false }).added).toBe(false);
    expect(addTableOfContents(SECTION("One", "a") + SECTION("Two", "b")).added).toBe(false);
    const once = addTableOfContents(ARTICLE).html;
    expect(hasTableOfContents(once)).toBe(true);
    expect(addTableOfContents(once).added).toBe(false);
  });

  it("localises the label", () => {
    const { html } = addTableOfContents(ARTICLE, { language: "it" });
    expect(html).toContain("<strong>Indice</strong>");
  });
});
