import { describe, it, expect } from "vitest";
import { prioritise, crawlPage, keywordForPage } from "../site-crawl";

// The crawl exists because domain-analysis walks links breadth-first to depth
// 2 and reached 2 of fitsuite.co's 204 posts. These pin the parts that decide
// what gets stored and how it is scored; discovery and upsert need a network
// and a database, and are exercised by scripts/crawl-site.ts.

describe("prioritise", () => {
  const urls = [
    "https://x.co/pricing",
    "https://x.co/blog/one",
    "https://x.co/about",
    "https://x.co/blog/two",
    "https://x.co/guida/tre",
  ];

  it("puts posts ahead of marketing pages, so the cap bites the right end", () => {
    expect(prioritise(urls, 3)).toEqual([
      "https://x.co/blog/one",
      "https://x.co/blog/two",
      "https://x.co/guida/tre",
    ]);
  });

  it("keeps the rest when there is room", () => {
    expect(prioritise(urls, 99)).toHaveLength(5);
  });
});

describe("crawlPage", () => {
  const domain = "x.co";
  const html = `<!doctype html><html><head>
    <title>Site Name</title>
    <meta name="description" content="A page about widget pricing and what it costs.">
    <meta property="og:title" content="Widget Pricing Explained">
    <meta property="article:published_time" content="2026-01-15T10:00:00Z">
    <script type="application/ld+json">{"@type":"Article","headline":"x"}</script>
    </head><body>
    <nav><a href="/pricing">Pricing</a></nav>
    <main>
      <h1>Widget Pricing Explained</h1>
      <p>Widget pricing is what a vendor charges per widget per month.</p>
      <h2>How much?</h2>
      <p>See <a href="/blog/rates">our rate guide</a> and <a href="https://gartner.com/r">Gartner</a>.</p>
    </main>
    <footer><a href="/terms">Terms</a></footer>
    </body></html>`;

  // A fetch stub, so the test is about parsing rather than the network.
  const serve = (body: string, init: { status?: number; type?: string } = {}) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, {
        status: init.status ?? 200,
        headers: { "content-type": init.type ?? "text/html; charset=utf-8" },
      })) as typeof fetch;
    return () => { globalThis.fetch = original; };
  };

  it("scores the article body, not the navigation and footer", async () => {
    const restore = serve(html);
    try {
      const p = await crawlPage("https://x.co/blog/widget-pricing", { domain });
      expect(p.status).toBe(200);
      // /pricing and /terms live outside <main> and must not be counted.
      expect(p.internal_links).toBe(1);
      expect(p.external_links).toBe(1);
      expect(p.title).toBe("Widget Pricing Explained");
      expect(p.h1).toBe("Widget Pricing Explained");
      expect(p.published_at).toBe("2026-01-15T10:00:00.000Z");
      expect(p.schema_types).toContain("Article");
      expect(p.seo_score).toBeGreaterThan(0);
      expect(p.aeo_score).not.toBeNull();
      expect(p.content_hash).toMatch(/^[0-9a-f]{32}$/);
    } finally { restore(); }
  });

  it("infers a keyword from the slug, and says it guessed", async () => {
    const restore = serve(html);
    try {
      const p = await crawlPage("https://x.co/blog/widget-pricing", { domain });
      expect(p.keyword_source).toBe("heading");
      expect(p.keyword).toBe("widget pricing");
    } finally { restore(); }
  });

  it("prefers the keyword the SERP reports for that exact page", async () => {
    const restore = serve(html);
    try {
      const p = await crawlPage("https://x.co/blog/widget-pricing", {
        domain,
        rankedByPath: new Map([["/blog/widget-pricing", { keyword: "widget cost", position: 12 }]]),
      });
      expect(p.keyword).toBe("widget cost");
      expect(p.keyword_source).toBe("ranked");
      expect(p.position).toBe(12);
    } finally { restore(); }
  });

  it("records a failure as a row rather than throwing", async () => {
    const restore = serve("nope", { status: 404 });
    try {
      const p = await crawlPage("https://x.co/gone", { domain });
      expect(p.status).toBe(404);
      expect(p.error).toBe("HTTP 404");
      expect(p.seo_score).toBeNull();
    } finally { restore(); }
  });

  it("does not score a page it cannot name a keyword for", async () => {
    // No H1, no ranked keyword, and a path with no words in it. Storing 0
    // would read as a measured zero; the page is still kept as a link target.
    const restore = serve("<html><head><title>x</title></head><body><main><p>hi</p></main></body></html>");
    try {
      const p = await crawlPage("https://x.co/", { domain });
      expect(p.status).toBe(200);
      expect(p.keyword).toBeNull();
      expect(p.seo_score).toBeNull();
      expect(p.aeo_score).toBeNull();
    } finally { restore(); }
  });

  it("skips a non-HTML response", async () => {
    const restore = serve("{}", { type: "application/json" });
    try {
      const p = await crawlPage("https://x.co/feed.json", { domain });
      expect(p.error).toBe("not HTML");
    } finally { restore(); }
  });
});

describe("keywordForPage", () => {
  // The H1 version made three checks unpassable: a full headline does not
  // appear inside its own H2, its own first sentence, or a 155-char meta
  // description. 38 of 40 fitsuite.co pages "failed" the meta check for that
  // reason alone. A slug is already the keyword somebody chose.
  it("reads the slug, dropping stopwords and the brand", () => {
    expect(keywordForPage("/blog/app-personal-trainer", null, "fitsuite.co")).toBe("app personal trainer");
    expect(keywordForPage("/blog/le-migliori-app-per-coach", null, "fitsuite.co")).toBe("app coach");
    expect(keywordForPage("/blog/fitsuite-vs-trainerize", null, "fitsuite.co")).toBe("trainerize");
  });

  it("caps the length, so a descriptive slug does not become the keyword whole", () => {
    const k = keywordForPage("/blog/coaching-powerlifting-programmazione-federazione-italiana-2026", null, "x.co");
    expect(k!.split(" ")).toHaveLength(3);
  });

  it("falls back to the H1 when the slug carries no words", () => {
    expect(keywordForPage("/2026/01/15/", "Widget Pricing Explained", "x.co")).toBe("widget pricing explained");
    expect(keywordForPage("/p/12345", "Widget Pricing", "x.co")).toBe("widget pricing");
  });

  it("returns null when there is nothing to go on", () => {
    expect(keywordForPage("/", null, "x.co")).toBeNull();
  });
});
