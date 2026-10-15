import { describe, it, expect } from "vitest";
import { rankTargets, relevance, isPlaceholderTarget, type PoolTarget } from "../targets";
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

  it("keeps a page switched off on /linking out, even when the crawl or a live article has it", () => {
    // "Stop linking to this page" leaves the pool row disabled, so the pool
    // query drops it, and the same URL used to come straight back from the
    // published/crawled list as a fresh entry.
    const out = rankTargets({
      pool: [],
      published,
      keyword: "crm",
      excluded: ["https://X.co/blog/crm-guide", "https://x.co/blog/email-deliverability/"],
    });
    expect(out).toEqual([]);
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

describe("isPlaceholderTarget", () => {
  it("drops the posts and pages a CMS ships with", () => {
    expect(isPlaceholderTarget({ title: "Hello world!", url: "https://acme.example/2019/01/hello-world/" })).toBe(true);
    expect(isPlaceholderTarget({ title: "Ciao mondo!", url: "https://acme.example/ciao-mondo/" })).toBe(true);
    expect(isPlaceholderTarget({ title: "Hallo wereld!", url: "https://acme.example/x/" })).toBe(true);
    expect(isPlaceholderTarget({ title: null, url: "https://acme.example/sample-page/" })).toBe(true);
  });

  it("keeps a real page that only mentions the words", () => {
    expect(isPlaceholderTarget({ title: "Hello world: our first boiler install", url: "https://acme.example/first-install/" })).toBe(false);
  });

  it("is applied by rankTargets", () => {
    const out = rankTargets({
      pool: [],
      published: [
        { title: "Hello world!", keyword: "hello world", url: "https://acme.example/hello-world/" },
        { title: "Boiler servicing", keyword: "boiler service", url: "https://acme.example/boiler-servicing/" },
      ],
      keyword: "boiler service",
    });
    expect(out.map((t) => t.url)).toEqual(["https://acme.example/boiler-servicing/"]);
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

describe("getLinkTargetsForPrompt", () => {
  it("drops a disabled pool page that the crawl also found", async () => {
    const { getLinkTargetsForPrompt } = await import("../targets");
    const tables: Record<string, Record<string, unknown>[]> = {
      link_targets: [
        { url: "https://x.co/blog/keep", title: "Keep", keyword: "keep", priority: 0, anchors: [], enabled: true, workspace_id: "ws" },
        { url: "https://x.co/blog/off", title: "Off", keyword: "off", priority: 0, anchors: [], enabled: false, workspace_id: "ws" },
      ],
      articles: [],
      site_pages: [{ url: "https://x.co/blog/off", title: "Off", keyword: "off", workspace_id: "ws" }],
    };
    const client = {
      from(table: string) {
        const eqs: [string, unknown][] = [];
        const b: Record<string, unknown> = {};
        for (const m of ["select", "not", "gte", "lt", "order", "limit", "neq"]) b[m] = () => b;
        b.eq = (k: string, v: unknown) => {
          eqs.push([k, v]);
          return b;
        };
        b.then = (resolve: (v: unknown) => unknown) =>
          resolve({
            data: (tables[table] ?? []).filter((r) => eqs.every(([k, v]) => k === "status" || k === "page_type" || r[k] === v)),
            error: null,
          });
        return b;
      },
    };
    const out = await getLinkTargetsForPrompt(client as never, "ws", { keyword: "off" });
    expect(out.map((t) => t.url)).toEqual(["https://x.co/blog/keep"]);
  });
});
