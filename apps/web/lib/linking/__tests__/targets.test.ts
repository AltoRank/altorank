import { describe, it, expect } from "vitest";
import { rankTargets, relevance, type PoolTarget } from "../targets";
import type { LinkTarget } from "@/lib/seo/link-resolver";

// The prompt shows twenty targets. These pin which twenty: a person's
// priority first, then the page's subject against the draft's keyword, then
// what we published ahead of what we merely read - and one entry per URL
// however many places know about it.

const pool: PoolTarget[] = [
  { url: "https://x.co/pricing", title: "Pricing", keyword: "pricing", priority: 3, anchors: ["see our pricing"] },
  { url: "https://x.co/blog/crm-guide", title: "The CRM Guide", keyword: "crm software", priority: 0, anchors: [] },
  { url: "https://x.co/blog/untitled-slug-here", title: null, keyword: null, priority: 1, anchors: [] },
];

const published: LinkTarget[] = [
  { url: "https://x.co/blog/email-deliverability", title: "Email Deliverability", keyword: "email deliverability" },
  { url: "https://x.co/blog/crm-guide/", title: "CRM Guide (published)", keyword: "crm" },
];

describe("rankTargets", () => {
  it("puts a person's priority ahead of everything", () => {
    const out = rankTargets({ pool, published, keyword: "email deliverability" });
    expect(out[0].url).toBe("https://x.co/pricing");
    expect(out[0].anchors).toEqual(["see our pricing"]);
  });

  it("then ranks by overlap with the draft's keyword", () => {
    const out = rankTargets({ pool: [], published, keyword: "crm software for teams" });
    expect(out[0].url).toBe("https://x.co/blog/crm-guide/");
  });

  it("then keeps our own live articles ahead of crawled pages", () => {
    const out = rankTargets({ pool: [], published, keyword: null });
    expect(out.map((t) => t.url)).toEqual(published.map((t) => t.url));
  });

  it("is one entry per URL, trailing slash or not, and the pool row wins", () => {
    const out = rankTargets({ pool, published });
    const crm = out.filter((t) => /crm-guide/.test(t.url));
    expect(crm).toHaveLength(1);
    expect(crm[0].title).toBe("The CRM Guide");
  });

  it("gives a pool row the crawl never titled its slug words, not an empty string", () => {
    const out = rankTargets({ pool, published });
    const bare = out.find((t) => t.url.endsWith("untitled-slug-here"))!;
    expect(bare.title).toBe("untitled slug here");
    expect(bare.keyword).toBe("untitled slug here");
  });

  it("lets a published row fill a pool row's missing title", () => {
    const out = rankTargets({
      pool: [{ url: "https://x.co/blog/email-deliverability", title: null, keyword: null, priority: 2, anchors: [] }],
      published,
    });
    expect(out[0].title).toBe("Email Deliverability");
    expect(out[0].keyword).toBe("email deliverability");
  });

  it("respects the limit", () => {
    expect(rankTargets({ pool, published, limit: 2 })).toHaveLength(2);
  });
});

describe("relevance", () => {
  it("is the share of the keyword's words the page's keyword or title carries", () => {
    expect(relevance("crm software", { keyword: "crm software", title: "x" })).toBe(1);
    expect(relevance("crm software", { keyword: "crm", title: "Guide" })).toBe(0.5);
    expect(relevance("crm software", { keyword: "email", title: "Deliverability" })).toBe(0);
  });

  it("is zero with no keyword", () => {
    expect(relevance(null, { keyword: "crm", title: "x" })).toBe(0);
  });
});
