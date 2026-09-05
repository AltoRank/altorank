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
