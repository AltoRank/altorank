import { describe, it, expect } from "vitest";
import { auditArticle, classifyHref, extractLinks, rollUp, type AuditItem } from "../article-audit";

const find = (items: AuditItem[], id: string): AuditItem => items.find((i) => i.id === id)!;

const base = {
  keyword: "email marketing software",
  siteDomain: "example.com",
  title: "The Best Email Marketing Software for Small Teams in 2026",
  metaDescription:
    "Compare the best email marketing software for small teams: pricing, deliverability and automation, with the trade-offs each tool makes, so you can pick in an afternoon.",
  slug: "best-email-marketing-software",
  featuredImageUrl: "https://cdn.example.com/x.png",
};

describe("classifyHref", () => {
  it("tells the site's own absolute URLs from outbound ones", () => {
    // scoring.ts calls anything not on five named domains "internal", and
    // aeo-scoring.ts calls every absolute URL "outbound". Both are wrong about
    // a resolved internal link, which the resolver writes as an absolute URL
    // on the workspace domain. Knowing the domain is the whole fix.
    expect(classifyHref("https://www.example.com/blog/post", "example.com")).toBe("internal");
    expect(classifyHref("https://docs.example.com/guide", "example.com")).toBe("internal");
    expect(classifyHref("https://hubspot.com/report", "example.com")).toBe("external");
    expect(classifyHref("/blog/post", "example.com")).toBe("internal");
  });

  it("names the links that go nowhere", () => {
    expect(classifyHref("#", "example.com")).toBe("dead");
    expect(classifyHref("", "example.com")).toBe("dead");
    expect(classifyHref("javascript:void(0)", "example.com")).toBe("dead");
    expect(classifyHref("#pricing", "example.com")).toBe("anchor");
    expect(classifyHref("{{internal-link:crm software}}", "example.com")).toBe("placeholder");
  });

  it("treats every absolute URL as outbound when the domain is unknown", () => {
    expect(classifyHref("https://example.com/x", null)).toBe("external");
  });
});

describe("extractLinks", () => {
  it("reads href and decoded anchor text, whatever else the tag carries", () => {
    // Tiptap's getHTML puts rel and target before or after href; the editor
    // escapes ampersands. Neither should change what we read.
    const html =
      '<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://a.com/r&amp;d">R&amp;D <strong>report</strong></a></p>';
    expect(extractLinks(html, "example.com")).toEqual([
      { href: "https://a.com/r&d", anchor: "R&D report", kind: "external" },
    ]);
  });
});

describe("auditArticle", () => {
  it("fails a draft with no links, no sources and a bare anchor", () => {
    // What every generated article looked like on 2026-09-03: prose, headings,
    // figures, and not one working link.
    const html = `
      <h1>The Best Email Marketing Software for Small Teams</h1>
      <p>Email marketing software sends campaigns. Around 42% of teams switch tools within a year.</p>
      <h2>Why does deliverability matter?</h2>
      <p>Studies show that most email never lands. <a href="#">Read more</a>.</p>
    `;
    const audit = auditArticle({ ...base, html });
    expect(find(audit.items, "internal-links").status).toBe("fail");
    expect(find(audit.items, "external-links").status).toBe("fail");
    expect(find(audit.items, "dead-links").status).toBe("fail");
    expect(find(audit.items, "dead-links").locate).toEqual(["Read more"]);
    // Dead links are not judged on their anchor text: they are going away.
    expect(audit.items.find((i) => i.id === "anchor-text")).toBeUndefined();
    expect(find(audit.items, "unsourced-figures").status).toBe("fail");
    expect(find(audit.items, "unsourced-figures").locate).toEqual(["42%"]);
    expect(find(audit.items, "hollow-evidence").status).toBe("warn");
    expect(find(audit.items, "hollow-evidence").locate).toEqual(["Studies show"]);
    expect(audit.verdict).toBe("needs-work");
  });

  it("passes the same checks once the links and sources are real", () => {
    const html = `
      <h1>The Best Email Marketing Software for Small Teams</h1>
      <p>Email marketing software sends campaigns to lists you own.</p>
      <h2>What does email marketing software cost?</h2>
      <p>Around 42% of teams switch tools within a year, according to
         <a href="https://www.litmus.com/state-of-email">Litmus</a>.</p>
      <p>Mailchimp's free tier covers 500 contacts, per its
         <a href="https://mailchimp.com/pricing/">pricing page</a>.</p>
      <p>We cover the alternatives in our guide to
         <a href="https://www.example.com/blog/crm-software">CRM software</a> and
         <a href="/blog/newsletter-tools">newsletter tools</a>.</p>
      <h2>Is it worth paying for deliverability?</h2>
      <p>Yes, when the list is over a few thousand. We tested three tools on the same list.</p>
    `;
    const audit = auditArticle({ ...base, html, linkableArticles: 4 });
    expect(find(audit.items, "internal-links").status).toBe("pass");
    expect(find(audit.items, "external-links").status).toBe("pass");
    expect(find(audit.items, "external-links").detail).toContain("2 domains");
    expect(find(audit.items, "dead-links").status).toBe("pass");
    expect(find(audit.items, "anchor-text").status).toBe("pass");
    expect(find(audit.items, "unsourced-figures").status).toBe("pass");
    expect(find(audit.items, "named-sources").status).toBe("pass");
    expect(find(audit.items, "first-hand").status).toBe("pass");
    // Honest about what it did not do.
    expect(find(audit.items, "sources-unverified").status).toBe("info");
    expect(audit.counts.fail).toBe(0);
  });

  it("warns on anchor text that says nothing about the destination", () => {
    const html =
      '<h1>x</h1><p>See <a href="https://a.com/report">click here</a> and <a href="/blog/guide">our deliverability guide</a>.</p>';
    const item = find(auditArticle({ ...base, html }).items, "anchor-text");
    expect(item.status).toBe("warn");
    expect(item.locate).toEqual(["click here"]);
  });

  it("says 'nothing to link to' rather than 'missing' when the site has no live article", () => {
    // A brand-new workspace cannot have internal links. Failing the draft for
    // it points the reviewer at the wrong fix.
    const html = "<h1>Email marketing software</h1><p>Email marketing software does things.</p>";
    const audit = auditArticle({ ...base, html, linkableArticles: 0 });
    const item = find(audit.items, "internal-links");
    expect(item.status).toBe("info");
    expect(item.detail).toContain("no other live article");
  });

  it("reports what the generation-time link check found, and where to look", () => {
    const html =
      '<h1>x</h1><p>See <a href="https://a.example/ok">Gartner</a> and <a href="https://b.example/waf">Litmus</a>.</p>';
    const stamp = "2026-09-03T12:00:00.000Z";
    const audit = auditArticle({
      ...base,
      html,
      linkChecks: [
        { url: "https://a.example/ok", status: 200, ok: true, removed: false, checkedAt: stamp },
        { url: "https://b.example/waf", status: 403, ok: false, reason: "HTTP 403, could not verify", removed: false, checkedAt: stamp },
      ],
    });
    expect(audit.items.find((i) => i.id === "sources-unverified")).toBeUndefined();
    const item = find(audit.items, "sources-verified");
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("1 of 2 cited URLs answered");
    expect(item.detail).toContain("HTTP 403");
    expect(item.locate).toEqual(["Litmus"]);
  });

  it("passes the check when every cited URL answered", () => {
    const html = '<h1>x</h1><p><a href="https://a.example/ok">Gartner</a></p>';
    const audit = auditArticle({
      ...base,
      html,
      linkChecks: [{ url: "https://a.example/ok", status: 200, ok: true, removed: false, checkedAt: "2026-09-03T12:00:00.000Z" }],
    });
    expect(find(audit.items, "sources-verified").status).toBe("pass");
  });

  it("flags a source that is named but not linked", () => {
    const html =
      "<h1>Email marketing software</h1><p>According to Gartner, spend rose 12% last year.</p>";
    const audit = auditArticle({ ...base, html });
    const item = find(audit.items, "named-sources");
    expect(item.status).toBe("warn");
    expect(item.locate).toEqual(["Gartner"]);
  });

  it("reads the outline: one H1, no skipped levels, keyword in a subheading", () => {
    const html = `
      <h1>A</h1><h1>B</h1>
      <p>Opening paragraph that does not mention the subject at all, for forty characters.</p>
      <h2>Pricing</h2><h4>Skipped a level</h4>
    `;
    const audit = auditArticle({ ...base, html });
    expect(find(audit.items, "single-h1").status).toBe("fail");
    expect(find(audit.items, "single-h1").locate).toEqual(["B"]);
    expect(find(audit.items, "heading-hierarchy").status).toBe("warn");
    expect(find(audit.items, "heading-hierarchy").locate).toEqual(["Skipped a level"]);
    expect(find(audit.items, "keyword-in-subheading").status).toBe("warn");
    expect(find(audit.items, "keyword-in-intro").status).toBe("warn");
  });

  it("checks the metadata the scorers only half check", () => {
    const html = "<h1>x</h1><p>Email marketing software, briefly.</p>";
    const audit = auditArticle({
      ...base,
      html,
      title: "A Very Long Title That Keeps Going Well Past The Point Where Google Stops Showing It",
      metaDescription: "Too short and no keyword.",
      slug: "a-very-long-title-that-keeps-going-well-past-the-point-where-google-stops",
      featuredImageUrl: null,
    });
    expect(find(audit.items, "title-length").status).toBe("warn");
    expect(find(audit.items, "title-length").detail).toContain("truncates");
    expect(find(audit.items, "meta-description").status).toBe("warn");
    expect(find(audit.items, "meta-description").detail).toContain("keyword");
    expect(find(audit.items, "slug").status).toBe("warn");
    expect(find(audit.items, "featured-image").status).toBe("warn");
    expect(find(audit.items, "meta-description").status).not.toBe("fail");
    expect(auditArticle({ ...base, html, metaDescription: null }).items.find((i) => i.id === "meta-description")!.status).toBe("fail");
  });

  it("wants alt text on every image, and only mentions images when there are any", () => {
    const none = auditArticle({ ...base, html: "<h1>x</h1><p>y</p>" });
    expect(none.items.find((i) => i.id === "image-alt")).toBeUndefined();

    const some = auditArticle({
      ...base,
      html: '<h1>x</h1><img src="a.png" alt="A chart"><img src="b.png" alt=""><img src="c.png">',
    });
    const alt = find(some.items, "image-alt");
    expect(alt.status).toBe("fail");
    expect(alt.detail).toContain("2 of 3");
  });

  it("does not fail an empty editor on things that need text", () => {
    // The editor is empty for a moment before content loads. The audit runs
    // then too, and must not throw.
    expect(() => auditArticle({ ...base, html: "" })).not.toThrow();
  });
});

describe("rollUp", () => {
  it("one fail is enough to need work; warnings alone are a review", () => {
    expect(rollUp({ fail: 1, warn: 0, pass: 9, info: 0 })).toBe("needs-work");
    expect(rollUp({ fail: 0, warn: 2, pass: 9, info: 3 })).toBe("review");
    expect(rollUp({ fail: 0, warn: 0, pass: 9, info: 3 })).toBe("ready");
  });
});
