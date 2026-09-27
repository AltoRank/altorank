import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FoundOnSiteBlindNote, FoundOnSiteNotice } from "../found-on-site-notice";
import { foundOnSiteView } from "@/lib/found-on-site/state";

// renderToStaticMarkup, as the other editor panels are tested: no jsdom in
// this repo, and the notice is pure presentation.
const text = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const view = foundOnSiteView({
  status: "live",
  published_url: "https://acme-agency.example/blog/kopya",
  found_on_site_at: "2026-09-23T10:00:00.000Z",
  found_on_site_evidence: { containment: 0.66, rule: "text" },
})!;

describe("FoundOnSiteNotice", () => {
  it("shows the distinct state, the page it was found on, and what the match rests on", () => {
    const html = text(renderToStaticMarkup(<FoundOnSiteNotice view={view} onUndo={() => {}} />));
    expect(html).toContain("Live on your site");
    expect(html).toContain('href="https://acme-agency.example/blog/kopya"');
    expect(html).toContain(`found it there on ${new Date(view.foundAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
    expect(html).toContain(view.when);
    expect(html).toContain("66% of the draft's text appears on that page word for word");
    expect(html).toContain("without going through AltoRank, and counts as published");
  });

  it("offers the undo, and says when it is running or failed", () => {
    expect(text(renderToStaticMarkup(<FoundOnSiteNotice view={view} onUndo={() => {}} />))).toContain("Not my article");
    const busy = renderToStaticMarkup(<FoundOnSiteNotice view={view} onUndo={() => {}} pending />);
    expect(busy).toContain("Putting it back");
    expect(busy).toMatch(/<button[^>]*disabled/);
    expect(renderToStaticMarkup(<FoundOnSiteNotice view={view} onUndo={() => {}} error="changed while it was being undone" />)).toContain(
      "changed while it was being undone",
    );
  });
});

describe("FoundOnSiteBlindNote", () => {
  it("says the site cannot be seen, in the Publish panel", () => {
    const html = text(renderToStaticMarkup(<FoundOnSiteBlindNote text="We can't see new pages on acme-agency.example: it has no sitemap." />));
    expect(html).toContain('role="note"');
    expect(html).toContain("We can't see new pages on acme-agency.example");
  });
});
