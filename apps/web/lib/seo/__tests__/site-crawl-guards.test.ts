import { describe, it, expect, afterEach, vi } from "vitest";
import { syncSitePages, crawlPage, DEFAULTS } from "../site-crawl";
import { assertPublicUrl } from "@/lib/audit/lenient-fetch";

// The three things that stop this crawler from being a nuisance or a
// liability: it asks robots.txt first, it stops at a wall-clock budget rather
// than trusting a page cap, and it refuses to fetch anything that is not a
// public website. Each is tested here against a fake network, because each was
// added for a reason a parsing test cannot express.

const PAGE = `<!doctype html><html><head><title>A page about widget pricing and renewals</title>
  <link rel="canonical" href="SELF">
  <meta name="description" content="What vendors charge per widget per month, what the setup fee covers, and how renewals are priced.">
  <meta property="og:title" content="x">
  <script type="application/ld+json">{"@type":"Article"}</script>
  </head><body><main><h1>Widget pricing</h1><p>${"word ".repeat(400)}</p>
  <a href="/blog/other">other</a></main></body></html>`;

/**
 * A network of exactly the URLs given. Everything else 404s, so a crawl that
 * wanders is visible rather than silently slow.
 */
function serve(routes: Record<string, { body?: string; status?: number; type?: string; delayMs?: number }>) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    const route = routes[url.replace(/\?.*$/, "")] ?? routes[url];
    if (!route) return new Response("no", { status: 404, headers: { "content-type": "text/html" } });
    if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: { "content-type": route.type ?? "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

/** Just enough Supabase for the crawl: reads return nothing, upserts succeed. */
function fakeSupabase() {
  const upserted: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null });
      if (prop === "upsert")
        return (rows: Record<string, unknown>[]) => {
          upserted.push(...rows);
          return { then: (res: (v: unknown) => void) => res({ error: null }) };
        };
      if (prop === "maybeSingle") return () => Promise.resolve({ data: null });
      return () => self;
    },
  });
  return { client: { from: () => self } as never, upserted };
}

const sitemap = (urls: string[]) =>
  `<?xml version="1.0"?><urlset>${urls.map((u) => `<loc>${u}</loc>`).join("")}</urlset>`;

afterEach(() => vi.restoreAllMocks());

describe("robots.txt", () => {
  it("does not fetch a path robots.txt disallows", async () => {
    const net = serve({
      "https://x.co/robots.txt": { body: "User-agent: *\nDisallow: /private/\n", type: "text/plain" },
      "https://x.co/sitemap.xml": { body: sitemap(["https://x.co/blog/a", "https://x.co/private/b"]), type: "text/xml" },
      "https://x.co/blog/a": { body: PAGE },
      "https://x.co/private/b": { body: PAGE },
    });
    try {
      const db = fakeSupabase();
      const r = await syncSitePages(db.client, "ws1", "x.co", { techChecks: true });
      expect(r.disallowed).toBe(1);
      expect(r.pages.map((p) => p.url)).toEqual(["https://x.co/blog/a"]);
      expect(net.seen).not.toContain("https://x.co/private/b");
    } finally { net.restore(); }
  });

  it("reports a site that refuses us entirely rather than crawling it anyway", async () => {
    const net = serve({
      "https://x.co/robots.txt": { body: "User-agent: *\nDisallow: /\n", type: "text/plain" },
      "https://x.co/sitemap.xml": { body: sitemap(["https://x.co/blog/a"]), type: "text/xml" },
      "https://x.co/blog/a": { body: PAGE },
    });
    try {
      const db = fakeSupabase();
      const r = await syncSitePages(db.client, "ws1", "x.co", { techChecks: true });
      expect(r.robotsBlocked).toBe(true);
      expect(r.pages).toHaveLength(0);
      expect(net.seen).not.toContain("https://x.co/blog/a");
    } finally { net.restore(); }
  });

  it("crawls normally when there is no robots.txt at all", async () => {
    const net = serve({
      "https://x.co/sitemap.xml": { body: sitemap(["https://x.co/blog/a"]), type: "text/xml" },
      "https://x.co/blog/a": { body: PAGE },
    });
    try {
      const db = fakeSupabase();
      const r = await syncSitePages(db.client, "ws1", "x.co", { techChecks: true });
      expect(r.robotsBlocked).toBe(false);
      expect(r.fetched).toBe(1);
    } finally { net.restore(); }
  });
});

describe("budget", () => {
  it("stops at the wall clock and stores what it read", async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://x.co/blog/p${i}`);
    const routes: Record<string, { body?: string; type?: string; delayMs?: number }> = {
      "https://x.co/sitemap.xml": { body: sitemap(urls), type: "text/xml" },
    };
    for (const u of urls) routes[u] = { body: PAGE, delayMs: 30 };
    const net = serve(routes);
    try {
      const db = fakeSupabase();
      const r = await syncSitePages(db.client, "ws1", "x.co", {
        techChecks: true,
        concurrency: 1,
        budgetMs: 120,
      });
      // Some, not all, and the ones it read are stored rather than discarded.
      expect(r.pages.length).toBeGreaterThan(0);
      expect(r.pages.length).toBeLessThan(urls.length);
      expect(r.truncated).toBe(true);
      expect(db.upserted).toHaveLength(r.pages.length);
    } finally { net.restore(); }
  });

  it("reports truncation when the page cap bites, not just the clock", async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://x.co/blog/p${i}`);
    const routes: Record<string, { body?: string; type?: string }> = {
      "https://x.co/sitemap.xml": { body: sitemap(urls), type: "text/xml" },
    };
    for (const u of urls) routes[u] = { body: PAGE };
    const net = serve(routes);
    try {
      const db = fakeSupabase();
      const r = await syncSitePages(db.client, "ws1", "x.co", { techChecks: true, maxPages: 2 });
      expect(r.pages).toHaveLength(2);
      expect(r.discovered).toBe(6);
      expect(r.truncated).toBe(true);
    } finally { net.restore(); }
  });

  it("has a default budget, so a caller that forgets one still cannot hang", () => {
    expect(DEFAULTS.budgetMs).toBeGreaterThan(0);
    expect(DEFAULTS.budgetMs).toBeLessThanOrEqual(300_000);
  });
});

describe("the private-address guard stays on the path", () => {
  it.each([
    "http://localhost:54321/x",
    "http://127.0.0.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/x",
    "http://[::1]/x",
    "file:///etc/passwd",
  ])("refuses %s", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });

  it("records the refusal as a row rather than throwing out of the crawl", async () => {
    const page = await crawlPage("http://169.254.169.254/latest/", { domain: "x.co", techChecks: true });
    expect(page.status).toBe(0);
    expect(page.error).toContain("private or local address");
    expect(page.tech_findings).toEqual([
      { code: "http_error", severity: "error", message: "The server did not answer for this URL." },
    ]);
  });

  /**
   * The hop that matters: a public URL that 302s to the metadata service. The
   * crawler follows redirects by hand for exactly this, so each hop goes back
   * through `fetchSite` and its guard.
   */
  it("refuses a redirect from a public page to a private address", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://x.co/go") {
        return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/" } });
      }
      return new Response("secret", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    try {
      const page = await crawlPage("https://x.co/go", { domain: "x.co", techChecks: true });
      expect(page.status).toBe(0);
      expect(page.error).toContain("private or local address");
    } finally { globalThis.fetch = original; }
  });
});

describe("what the crawl records", () => {
  it("stores findings on each page and rolls them up", async () => {
    const bad = `<html><head><title>Home</title></head><body><main><p>short</p><img src="/a.png"></main></body></html>`;
    const net = serve({
      "https://x.co/sitemap.xml": { body: sitemap(["https://x.co/blog/a", "https://x.co/blog/b"]), type: "text/xml" },
      "https://x.co/blog/a": { body: bad },
      "https://x.co/blog/b": { body: bad },
    });
    try {
      const db = fakeSupabase();
      const r = await syncSitePages(db.client, "ws1", "x.co", { techChecks: true });
      expect(r.tech).not.toBeNull();
      expect(r.tech!.pages).toBe(2);
      expect(r.tech!.pagesWithIssues).toBe(2);
      const codes = r.pages.flatMap((p) => (p.tech_findings ?? []).map((f) => f.code));
      expect(codes).toContain("meta_description_missing");
      expect(codes).toContain("images_missing_alt");
      expect(codes).toContain("thin_content");
      // Two pages, one title: the cross-page pass sees what a single page cannot.
      expect(codes).toContain("duplicate_title");
      // The count column travels with the findings, and matches them.
      for (const p of r.pages) expect(p.tech_issue_count).toBe(p.tech_findings!.length);
    } finally { net.restore(); }
  });

  /** Null means unchecked, and it must not become an empty array by accident. */
  it("writes no findings at all when it was not asked for them", async () => {
    const net = serve({
      "https://x.co/sitemap.xml": { body: sitemap(["https://x.co/blog/a"]), type: "text/xml" },
      "https://x.co/blog/a": { body: PAGE },
    });
    try {
      const db = fakeSupabase();
      const r = await syncSitePages(db.client, "ws1", "x.co", {});
      expect(r.tech).toBeNull();
      expect(db.upserted[0].tech_findings).toBeNull();
      expect(db.upserted[0].tech_checked_at).toBeNull();
    } finally { net.restore(); }
  });

  it("gives every row in an upsert chunk the same keys, which PostgREST requires", async () => {
    const net = serve({
      "https://x.co/sitemap.xml": {
        body: sitemap(["https://x.co/blog/a", "https://x.co/gone", "https://x.co/feed"]),
        type: "text/xml",
      },
      "https://x.co/blog/a": { body: PAGE },
      "https://x.co/gone": { status: 404, body: "no" },
      "https://x.co/feed": { body: "{}", type: "application/json" },
    });
    try {
      const db = fakeSupabase();
      await syncSitePages(db.client, "ws1", "x.co", { techChecks: true });
      expect(db.upserted.length).toBeGreaterThan(1);
      const keys = db.upserted.map((r) => Object.keys(r).sort().join(","));
      expect(new Set(keys).size).toBe(1);
    } finally { net.restore(); }
  });
});
