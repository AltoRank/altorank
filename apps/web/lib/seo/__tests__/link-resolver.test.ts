import { describe, it, expect } from "vitest";
import { resolveInternalLinks, type LinkTarget } from "../link-resolver";

// Every generated article shipped with dead internal links on 2026-09-03: the
// prompt offered drafts the resolver would not match, a miss fell back to a
// guessed `/slug`, and a workspace with nothing live got `href="#"` on every
// placeholder. These tests pin the three rules that replaced that.

const targets: LinkTarget[] = [
  {
    keyword: "crm software",
    title: "The Best CRM Software for Small Teams",
    url: "https://www.example.com/blog/best-crm-software",
  },
  {
    keyword: "email deliverability",
    title: "Email Deliverability: Why Mail Lands in Spam",
    url: "https://www.example.com/blog/email-deliverability",
  },
];

describe("resolveInternalLinks", () => {
  it("replaces a placeholder with the observed published URL, not a built one", () => {
    const html = '<p>See our <a href="{{internal-link:crm software}}">CRM guide</a>.</p>';
    expect(resolveInternalLinks(html, targets)).toBe(
      '<p>See our <a href="https://www.example.com/blog/best-crm-software">CRM guide</a>.</p>',
    );
  });

  it("matches a near topic by word overlap", () => {
    const html = '<a href="{{internal-link:deliverability of email}}">why mail bounces</a>';
    expect(resolveInternalLinks(html, targets)).toContain(
      "https://www.example.com/blog/email-deliverability",
    );
  });

  it("unwraps a placeholder that matches nothing, keeping the words", () => {
    // Before: `href="/pricing-strategy"`, a path nobody had ever observed.
    const html = '<p>Read about <a href="{{internal-link:pricing strategy}}">pricing strategy</a> too.</p>';
    expect(resolveInternalLinks(html, targets)).toBe("<p>Read about pricing strategy too.</p>");
  });

  it("unwraps every placeholder when the site has nothing live", () => {
    // Before: every one became `href="#"`, which survived into the stored
    // document because the dead-link pass had already run.
    const html =
      '<p><a href="{{internal-link:crm software}}">CRM</a> and <a href="{{internal-link:x}}">more</a>.</p>';
    const out = resolveInternalLinks(html, []);
    expect(out).toBe("<p>CRM and more.</p>");
    expect(out).not.toContain("href");
  });

  it("uses each target once", () => {
    const html =
      '<a href="{{internal-link:crm software}}">a</a> <a href="{{internal-link:crm tools}}">b</a>';
    const out = resolveInternalLinks(html, targets);
    // The exact match takes the CRM page; the near match must not land on the
    // same page, and with nothing else close enough it is unwrapped.
    expect(out.match(/best-crm-software/g)).toHaveLength(1);
    expect(out).toContain(" b");
  });

  it("is case- and whitespace-insensitive on the topic", () => {
    const html = '<a href="{{internal-link:  CRM Software }}">x</a>';
    expect(resolveInternalLinks(html, targets)).toContain("best-crm-software");
  });

  it("leaves HTML without placeholders untouched", () => {
    const html = '<p><a href="https://other.com">x</a> and <a href="#">y</a></p>';
    expect(resolveInternalLinks(html, targets)).toBe(html);
  });
});

describe("resolveInternalLinks with preferred anchors", () => {
  // A row of the link pool can carry the anchor texts its owner wants. The
  // resolver honours them; a target without any keeps the writer's words.
  const withAnchors: LinkTarget[] = [
    {
      keyword: "personal trainer app",
      title: "The App for Personal Trainers",
      url: "https://www.example.com/app",
      anchors: ["personal trainer app", "our coaching app"],
    },
    ...targets,
  ];

  it("keeps the writer's anchor when it is one of the preferred ones", () => {
    const html = '<p>Try the <a href="{{internal-link:personal trainer app}}">our coaching app</a>.</p>';
    expect(resolveInternalLinks(html, withAnchors)).toBe(
      '<p>Try the <a href="https://www.example.com/app">our coaching app</a>.</p>',
    );
  });

  it("swaps in the first preferred anchor when the writer's is not on the list", () => {
    const html = '<p>Try <a href="{{internal-link:personal trainer app}}">this tool</a>.</p>';
    expect(resolveInternalLinks(html, withAnchors)).toBe(
      '<p>Try <a href="https://www.example.com/app">personal trainer app</a>.</p>',
    );
  });

  it("leaves the writer's anchor alone on a target with no preferred anchors", () => {
    const html = '<a href="{{internal-link:crm software}}">our CRM guide</a>';
    expect(resolveInternalLinks(html, withAnchors)).toBe(
      '<a href="https://www.example.com/blog/best-crm-software">our CRM guide</a>',
    );
  });

  it("matches a topic written as a preferred anchor, not only as the keyword", () => {
    const html = '<a href="{{internal-link:our coaching app}}">x</a>';
    expect(resolveInternalLinks(html, withAnchors)).toContain("https://www.example.com/app");
  });

  it("keeps other attributes on the anchor tag", () => {
    const html = '<a class="c" href="{{internal-link:crm software}}" title="t">CRM</a>';
    expect(resolveInternalLinks(html, withAnchors)).toBe(
      '<a class="c" href="https://www.example.com/blog/best-crm-software" title="t">CRM</a>',
    );
  });
});

// ---------------------------------------------------------------------------
// Links the writer invented on its own domain
// ---------------------------------------------------------------------------
//
// The first draft for a fresh site (2026-09-05) carried four internal links
// to paths that do not exist on the site, written on an empty pool. The words
// stay, the link goes, and a rewrite keeps the links the page already had.

import { existingInternalLinks, unwrapUnknownInternalLinks } from "../link-resolver";
import { isKnownPage, normaliseSiteUrl } from "../links";

describe("unwrapUnknownInternalLinks", () => {
  const domain = "example.com";
  const pool = [{ url: "https://www.example.com/blog/venture-building" }];

  it("unwraps every same-domain link to a page not in the pool, keeping the anchor text", () => {
    const html =
      "<p>A <a href=\"/glossary/startup-studio\">startup studio</a> and " +
      '<a href="https://example.com/guides/founder-equity-splits">equity splits</a>, ' +
      'per <a href="https://hbr.org/x">HBR</a>.</p>';
    const { html: out, removed } = unwrapUnknownInternalLinks(html, domain, []);
    expect(out).toBe('<p>A startup studio and equity splits, per <a href="https://hbr.org/x">HBR</a>.</p>');
    expect(removed.map((r) => r.href)).toEqual([
      "/glossary/startup-studio",
      "https://example.com/guides/founder-equity-splits",
    ]);
    expect(removed[0].anchor).toBe("startup studio");
  });

  it("keeps a link to a page in the pool, however the two URLs are spelled", () => {
    const html =
      '<p><a href="https://example.com/blog/venture-building/">pool page</a> ' +
      '<a href="/blog/venture-building?utm=x#top">also the pool page</a> ' +
      '<a href="/blog/made-up">not</a></p>';
    const { html: out, removed } = unwrapUnknownInternalLinks(html, domain, pool);
    expect(out).toContain('<a href="https://example.com/blog/venture-building/">pool page</a>');
    expect(out).toContain('<a href="/blog/venture-building?utm=x#top">also the pool page</a>');
    expect(out).toContain(" not</p>");
    expect(removed.map((r) => r.href)).toEqual(["/blog/made-up"]);
  });

  it("treats www and bare domain as the same site, and leaves the site root alone", () => {
    const html = '<p><a href="https://www.example.com/">home</a> <a href="https://www.example.com/nope">x</a></p>';
    const { html: out } = unwrapUnknownInternalLinks(html, "www.example.com", []);
    expect(out).toBe('<p><a href="https://www.example.com/">home</a> x</p>');
  });

  it("does not touch outbound links, in-page anchors or mailto", () => {
    const html = '<p><a href="https://example.org/a">a</a> <a href="#faq">b</a> <a href="mailto:x@y.z">c</a></p>';
    expect(unwrapUnknownInternalLinks(html, domain, []).html).toBe(html);
  });

  it("is a no-op when the pool knows every link", () => {
    const html = '<p><a href="/blog/venture-building">ok</a></p>';
    const { html: out, removed } = unwrapUnknownInternalLinks(html, domain, pool);
    expect(out).toBe(html);
    expect(removed).toEqual([]);
  });

  it("keeps the links a page being rewritten already had", () => {
    const existing = '<p><a href="/services/corporate-venturing">services</a></p>';
    const known = [...pool, ...existingInternalLinks(existing, domain)];
    const rewrite =
      '<p><a href="https://example.com/services/corporate-venturing">services</a> ' +
      '<a href="/services/new-invention">new</a></p>';
    expect(unwrapUnknownInternalLinks(rewrite, domain, known).html).toBe(
      '<p><a href="https://example.com/services/corporate-venturing">services</a> new</p>',
    );
  });
});

describe("isKnownPage / normaliseSiteUrl", () => {
  it("normalises host, trailing slash, query and hash", () => {
    expect(normaliseSiteUrl("https://www.Example.com/Blog/Post/?a=1#x", "example.com")).toBe("example.com/blog/post");
    expect(normaliseSiteUrl("/blog/post", "https://www.example.com/")).toBe("example.com/blog/post");
  });

  it("knows the site root and the pool, and nothing else", () => {
    const pool = [{ url: "https://example.com/blog/post" }];
    expect(isKnownPage("/", "example.com", pool)).toBe(true);
    expect(isKnownPage("https://www.example.com", "example.com", [])).toBe(true);
    expect(isKnownPage("/blog/post/", "example.com", pool)).toBe(true);
    expect(isKnownPage("/blog/other", "example.com", pool)).toBe(false);
    // No domain: a relative path cannot be the root of a site we cannot name.
    expect(isKnownPage("/", null, [])).toBe(false);
  });
});
