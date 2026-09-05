import { describe, it, expect } from "vitest";
import { canonicalUrl, checkInlineCitations, findSourcesFooter } from "../inline-citations";

const site = "example.com";

const body = `
  <h1>The Best Email Marketing Software for Small Teams</h1>
  <p>Around <a href="https://www.litmus.com/report/">42% of teams</a> switch tools within a year.</p>
  <h2>Why does deliverability matter?</h2>
  <p>Google's <a href="https://developers.google.com/gmail/sender">sender guidelines</a> set the floor.</p>
`;

describe("findSourcesFooter", () => {
  it("finds a heading called Sources and runs it to the end", () => {
    const html = `${body}<h2>Sources</h2><ul><li><a href="https://a.org/x">A</a></li></ul>`;
    const footer = findSourcesFooter(html)!;
    expect(footer.label).toBe("sources");
    expect(footer.level).toBe(2);
    expect(html.slice(footer.start, footer.end)).toContain("https://a.org/x");
  });

  it("stops at the next heading of the same level, so a FAQ after it is body", () => {
    const html = `${body}<h2>References</h2><ul><li><a href="https://a.org/x">A</a></li></ul><h2>FAQ</h2><p><a href="https://b.org/y">B</a></p>`;
    const footer = findSourcesFooter(html)!;
    const slice = html.slice(footer.start, footer.end);
    expect(slice).toContain("https://a.org/x");
    expect(slice).not.toContain("https://b.org/y");
  });

  it("accepts a bold paragraph label, and the languages the product writes in", () => {
    expect(findSourcesFooter(`${body}<p><strong>Sources:</strong></p><ul></ul>`)?.level).toBeNull();
    expect(findSourcesFooter(`${body}<h3>Fonti e riferimenti</h3>`)?.label).toBe("fonti e riferimenti");
    expect(findSourcesFooter(`${body}<h2>Quellen</h2>`)?.label).toBe("quellen");
    expect(findSourcesFooter(`${body}<h2>Fuentes</h2>`)?.label).toBe("fuentes");
  });

  it("does not mistake a real section for a footer", () => {
    // "Sources of traffic" is a section about traffic sources; a prefix
    // match would have flagged every link in it as an orphaned citation.
    expect(findSourcesFooter(`${body}<h2>Sources of traffic worth tracking</h2><p>x</p>`)).toBeNull();
    expect(findSourcesFooter(`${body}<p>Sources vary by region.</p>`)).toBeNull();
    expect(findSourcesFooter(body)).toBeNull();
  });
});

describe("canonicalUrl", () => {
  it("treats two spellings of one page as the same source", () => {
    const a = canonicalUrl("https://www.site.org/report/");
    expect(canonicalUrl("http://site.org/report?utm_source=x&utm_medium=y#top")).toBe(a);
    expect(canonicalUrl("HTTPS://Site.org/Report")).toBe(a);
    // A real query parameter is part of the address.
    expect(canonicalUrl("https://site.org/report?page=2")).not.toBe(a);
  });

  it("leaves something that is not a URL alone rather than throwing", () => {
    expect(canonicalUrl("  Not A Url ")).toBe("not a url");
  });
});

describe("checkInlineCitations", () => {
  it("has nothing to say when there is no footer", () => {
    expect(checkInlineCitations(body, site)).toEqual({ footer: null, footerUrls: [], orphaned: [] });
  });

  it("passes a footer whose every URL is also linked at the claim", () => {
    const html = `${body}<h2>Sources</h2><ul>
      <li><a href="http://litmus.com/report?utm_source=newsletter">Litmus, State of Email</a></li>
      <li><a href="https://developers.google.com/gmail/sender#requirements">Google sender guidelines</a></li>
    </ul>`;
    const report = checkInlineCitations(html, site);
    expect(report.footer?.label).toBe("sources");
    expect(report.footerUrls).toHaveLength(2);
    expect(report.orphaned).toEqual([]);
  });

  it("names the footer URLs that appear nowhere in the body", () => {
    // The shape a model produces when it "cites" by appending a list: the
    // claim up top has no link, the evidence sits three screens below it.
    const html = `${body}<h2>Sources</h2><ol>
      <li><a href="https://www.litmus.com/report">Litmus</a></li>
      <li><a href="https://hbr.org/2024/01/email">HBR on email fatigue</a></li>
      <li>https://www.statista.com/email-users/</li>
    </ol>`;
    const report = checkInlineCitations(html, site);
    expect(report.footerUrls).toHaveLength(3);
    expect(report.orphaned).toEqual([
      { href: "https://hbr.org/2024/01/email", anchor: "HBR on email fatigue" },
      { href: "https://www.statista.com/email-users/", anchor: "https://www.statista.com/email-users/" },
    ]);
  });

  it("ignores the site's own links and in-page anchors in the footer", () => {
    const html = `${body}<h2>Sources</h2><ul>
      <li><a href="https://example.com/blog/deliverability">Our deliverability guide</a></li>
      <li><a href="#top">Back to top</a></li>
    </ul>`;
    expect(checkInlineCitations(html, site).footerUrls).toEqual([]);
  });

  it("counts a URL linked only after the footer as inline, since the footer ended", () => {
    const html = `${body}<h2>Sources</h2><ul><li><a href="https://a.org/x">A</a></li></ul>
      <h2>FAQ</h2><p>See <a href="https://a.org/x">A's report</a>.</p>`;
    expect(checkInlineCitations(html, site).orphaned).toEqual([]);
  });

  it("does not throw on an empty editor", () => {
    expect(() => checkInlineCitations("", site)).not.toThrow();
  });
});
