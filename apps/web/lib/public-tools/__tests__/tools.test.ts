import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import type { Block, KvBlock, TableBlock } from "../blocks";
import { ToolError } from "../errors";
import { UnsafeUrlError } from "../safe-fetch";
import { fakeFetch, ctxWith, page } from "./fake-fetch";
import { aiCrawlerSimulator, jsDependence, looksLikeChallenge, CRAWLERS } from "../tools/ai-crawler-simulator";
import { websiteMetadataChecker, analyseMetadata, readJsonLd } from "../tools/website-metadata-checker";
import { robotsTxtTester } from "../tools/robots-txt-tester";
import { canonicalChecker, canonicalsFromLinkHeader, urlDifference } from "../tools/canonical-checker";
import { sitemapChecker, parseSitemapXml, isValidLastmod, sample, MAX_FILES } from "../tools/sitemap-checker";
import { linkExtractor, extractLinks } from "../tools/link-extractor";

const kvOf = (blocks: Block[], title: string) => blocks.find((b): b is KvBlock => b.type === "kv" && b.title === title)!;
const tableOf = (blocks: Block[], title: string) => blocks.find((b): b is TableBlock => b.type === "table" && b.title === title)!;
const item = (b: KvBlock, label: string) => b.items.find((i) => i.label === label);

const ARTICLE = page("<title>Hello</title>", `<main><h1>Hello</h1><p>${"word ".repeat(300)}</p></main>`);

// ── ai-crawler-simulator ──────────────────────────────────────────────────────

describe("ai-crawler-simulator", () => {
  it("detects JS-dependent shells and bot challenges", () => {
    expect(jsDependence('<body><div id="root"></div><script src=a></script></body>', 0)).toBe("yes");
    expect(jsDependence("<body><noscript>Please enable JavaScript</noscript><p>a b c</p></body>", 60)).toBe("likely");
    expect(jsDependence(ARTICLE, 300)).toBe("no");
    expect(looksLikeChallenge({ status: 403, headers: {}, body: "<title>Just a moment...</title>" })).toBe(true);
    expect(looksLikeChallenge({ status: 200, headers: { "cf-mitigated": "challenge" }, body: "" })).toBe(true);
    expect(looksLikeChallenge({ status: 404, headers: {}, body: "not found" })).toBe(false);
  });

  it("reports robots verdicts, per-bot fetches, and flags a UA block", async () => {
    const fetch = fakeFetch((url, opts) => {
      if (url === "https://x.com/robots.txt") return { body: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n" };
      if (url === "https://x.com/") {
        if (opts.userAgent?.includes("ClaudeBot")) return { status: 403, body: "<title>Just a moment...</title>" };
        return { body: ARTICLE };
      }
    });
    const blocks = await aiCrawlerSimulator.run({ url: "https://x.com/" }, ctxWith(fetch));

    // one browser baseline + one robots + one per fetchable crawler; Google-Extended never fetched
    const fetchable = CRAWLERS.filter((c) => c.userAgent).length;
    expect(fetch).toHaveBeenCalledTimes(2 + fetchable);
    expect(fetch.mock.calls.some(([, o]) => o?.userAgent?.includes("Google-Extended"))).toBe(false);

    const per = kvOf(blocks, "Per crawler");
    expect(item(per, "GPTBot")).toMatchObject({ value: "blocked by robots.txt", status: "fail" });
    expect(item(per, "Google-Extended")).toMatchObject({ value: "blocked by robots.txt", status: "warn" });
    expect(item(per, "ClaudeBot")?.status).toBe("fail");
    expect(item(per, "Googlebot")).toMatchObject({ status: "pass" });

    const flags = blocks.find((b) => b.type === "list" && b.title?.startsWith("Crawlers treated differently"));
    expect(JSON.stringify(flags)).toMatch(/ClaudeBot gets a bot challenge page/);

    const details = tableOf(blocks, "Details");
    const googleRow = details.rows.find((r) => r[0] === "Googlebot")!;
    expect(googleRow[3]).toBe(200);
    expect(googleRow[6]).toBeGreaterThan(250);
  });

  it("is an upstream error when even a browser cannot fetch the page", async () => {
    const fetch = fakeFetch({ "https://x.com/robots.txt": { status: 404 } });
    await expect(aiCrawlerSimulator.run({ url: "https://x.com/" }, ctxWith(fetch))).rejects.toMatchObject({ code: "upstream" });
  });

  it("turns a private redirect into invalid_input", async () => {
    const fetch = fakeFetch((url) => (url.endsWith("robots.txt") ? { status: 404 } : new UnsafeUrlError("127.0.0.1 is a private or local address.")));
    await expect(aiCrawlerSimulator.run({ url: "https://x.com/" }, ctxWith(fetch))).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ── website-metadata-checker ─────────────────────────────────────────────────

describe("website-metadata-checker", () => {
  const head = [
    "<title>A good title for a page about widgets</title>",
    `<meta content="${"A description long enough to be useful in a result page. ".repeat(2)}" name="description">`,
    '<link rel="canonical" href="https://x.com/">',
    '<meta name=viewport content="width=device-width, initial-scale=1">',
    '<meta property="og:title" content="T"><meta property="og:description" content="D"><meta property="og:image" content="https://x.com/i.png">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<link rel="alternate" hreflang="en" href="https://x.com/"><link rel="alternate" hreflang="x-default" href="https://x.com/">',
    '<link rel="icon" href="/favicon.png"><meta charset="utf-8">',
    '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script>',
    '<script type="application/ld+json">{ broken </script>',
    "<!-- <meta name=\"robots\" content=\"noindex\"> -->",
  ].join("");

  it("reads attributes in any order and ignores commented-out tags", () => {
    const r = analyseMetadata(page(head, "<h1>One</h1>"), "https://x.com/", {});
    const get = (l: string) => r.items.find((i) => i.label === l);
    expect(get("Title")?.status).toBe("pass");
    expect(get("Meta description")?.value).toMatch(/^A description long enough/);
    expect(get("Canonical")).toMatchObject({ status: "pass" });
    expect(get("Robots meta")?.status).toBe("pass");
    expect(get("Viewport")?.status).toBe("pass");
    expect(get("Language (html lang)")?.value).toBe("en");
    expect(get("H1 headings")?.status).toBe("pass");
    expect(get("hreflang")?.value).toMatch(/2 alternates, with x-default/);
    expect(get("Open Graph")?.status).toBe("pass");
    expect(get("Structured data (JSON-LD)")?.status).toBe("fail");
  });

  it("lists JSON-LD types including @graph and arrays, and flags invalid JSON", () => {
    const r = readJsonLd(page(head, ""));
    expect(r.types).toEqual(["Organization", "WebSite", "Thing"]);
    expect(r.invalid).toBe(1);
    expect(r.errors[0]).toMatch(/block 2 is not valid JSON/);
  });

  it("flags missing basics and a noindex header", () => {
    const r = analyseMetadata("<html><head></head><body><h1>a</h1><h1>b</h1></body></html>", "https://x.com/", { "x-robots-tag": "noindex" });
    const get = (l: string) => r.items.find((i) => i.label === l);
    expect(get("Title")?.status).toBe("fail");
    expect(get("Meta description")?.status).toBe("fail");
    expect(get("Viewport")?.status).toBe("fail");
    expect(get("X-Robots-Tag header")?.status).toBe("fail");
    expect(get("Indexable")?.status).toBe("fail");
    expect(get("H1 headings")?.status).toBe("warn");
  });

  it("runs end to end", async () => {
    const blocks = await websiteMetadataChecker.run({ url: "https://x.com/" }, ctxWith(fakeFetch({ "https://x.com/": { body: page(head, "<h1>x</h1>"), headers: { "content-type": "text/html" } } })));
    expect(kvOf(blocks, "Metadata").items.length).toBeGreaterThan(10);
    expect(tableOf(blocks, "Open Graph and Twitter").rows.find((r) => r[0] === "og:image")?.[1]).toBe("https://x.com/i.png");
  });

  it("maps a fetch failure to upstream", async () => {
    await expect(websiteMetadataChecker.run({ url: "https://x.com/" }, ctxWith(fakeFetch({})))).rejects.toBeInstanceOf(ToolError);
  });
});

// ── robots-txt-tester ────────────────────────────────────────────────────────

describe("robots-txt-tester", () => {
  const file = "User-agent: *\nDisallow: /admin/\nAllow: /admin/public\n\nUser-agent: GPTBot\nDisallow: /\nSitemap: https://x.com/sitemap.xml\n";
  const fetch = () => fakeFetch({ "https://x.com/robots.txt": { body: file } });

  it("tests the default crawler set, with the deciding line", async () => {
    const blocks = await robotsTxtTester.run({ url: "https://x.com/admin/public/page", userAgent: undefined }, ctxWith(fetch()));
    const t = blocks.find((b): b is TableBlock => b.type === "table")!;
    const row = (name: string) => t.rows.find((r) => r[0] === name)!;
    expect(row("GPTBot").slice(1)).toEqual(["blocked", "Disallow: / (line 6)", "GPTBot"]);
    expect(row("Googlebot").slice(1)).toEqual(["allowed", "Allow: /admin/public (line 3)", "*"]);
    expect(blocks.some((b) => b.type === "code" && b.code === file)).toBe(true);
    expect(JSON.stringify(blocks)).toMatch(/sitemap\.xml/);
  });

  it("tests one user agent given as a full UA string", async () => {
    const blocks = await robotsTxtTester.run(
      { url: "https://x.com/", userAgent: "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)" },
      ctxWith(fetch()),
    );
    const t = blocks.find((b): b is TableBlock => b.type === "table")!;
    expect(t.rows).toEqual([["GPTBot", "blocked", "Disallow: / (line 6)", "GPTBot"]]);
  });

  it("says so when robots.txt is missing or unreachable", async () => {
    const missing = await robotsTxtTester.run({ url: "https://x.com/", userAgent: undefined }, ctxWith(fakeFetch({ "https://x.com/robots.txt": { status: 404 } })));
    expect(JSON.stringify(missing)).toMatch(/every URL is allowed/);
    const down = await robotsTxtTester.run({ url: "https://x.com/", userAgent: undefined }, ctxWith(fakeFetch({ "https://x.com/robots.txt": { status: 503 } })));
    expect(kvOf(down, "robots.txt").items[0].status).toBe("fail");
    expect(down.find((b): b is TableBlock => b.type === "table")!.rows.every((r) => r[1] === "blocked")).toBe(true);
  });
});

// ── canonical-checker ────────────────────────────────────────────────────────

describe("canonical-checker", () => {
  it("parses a Link header and classifies URL differences", () => {
    expect(canonicalsFromLinkHeader('<https://x.com/a>; rel="canonical", <https://x.com/b.pdf>; rel="alternate"')).toEqual(["https://x.com/a"]);
    expect(urlDifference("https://x.com/a", "https://x.com/a")).toBeNull();
    expect(urlDifference("https://x.com/a/", "https://x.com/a")).toBe("trailing slash");
    expect(urlDifference("https://x.com/a", "http://www.x.com/a")).toBe("https vs http, www vs non-www");
  });

  it("passes a self-referencing canonical without fetching again", async () => {
    const fetch = fakeFetch({ "https://x.com/a": { body: page('<link rel="canonical" href="https://x.com/a">', "") } });
    const blocks = await canonicalChecker.run({ url: "https://x.com/a" }, ctxWith(fetch));
    expect(item(kvOf(blocks, "Canonical"), "Self-referencing")?.status).toBe("pass");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("flags a conflict between HTML and header, and a canonical in <body>", async () => {
    const fetch = fakeFetch({
      "https://x.com/a": {
        body: page('<link rel="canonical" href="https://x.com/a">', '<link rel="canonical" href="https://x.com/b">'),
        headers: { link: '<https://x.com/c>; rel="canonical"' },
      },
      "https://x.com/b": { body: page("", "") },
    });
    const blocks = await canonicalChecker.run({ url: "https://x.com/a" }, ctxWith(fetch));
    const k = kvOf(blocks, "Canonical");
    expect(item(k, "Conflict")?.status).toBe("fail");
    expect(item(k, "Placement")?.status).toBe("fail");
  });

  it("checks the target: redirect, noindex and its own canonical", async () => {
    const fetch = fakeFetch((url, opts) => {
      if (url === "https://x.com/a/") return { body: page('<link rel="canonical" href="/a">', "") };
      if (url === "https://x.com/a") {
        if (opts.followRedirects === false) return { status: 301, headers: { location: "https://x.com/final" } };
        return { finalUrl: "https://x.com/final", body: page('<meta name="robots" content="noindex"><link rel="canonical" href="https://x.com/other">', "") };
      }
    });
    const blocks = await canonicalChecker.run({ url: "https://x.com/a/" }, ctxWith(fetch));
    const canon = kvOf(blocks, "Canonical");
    expect(item(canon, "Absolute")?.status).toBe("warn");
    expect(item(canon, "Self-referencing")?.value).toMatch(/trailing slash/);
    const target = kvOf(blocks, "The canonical target");
    expect(item(target, "Canonical target")?.status).toBe("fail");
    expect(item(target, "Target indexable")?.status).toBe("fail");
    expect(item(target, "Target's own canonical")?.status).toBe("fail");
  });

  it("warns when there is no canonical at all", async () => {
    const blocks = await canonicalChecker.run({ url: "https://x.com/" }, ctxWith(fakeFetch({ "https://x.com/": { body: page("", "") } })));
    expect(item(kvOf(blocks, "Canonical"), "Canonical")?.status).toBe("warn");
  });
});

// ── sitemap-checker ──────────────────────────────────────────────────────────

describe("sitemap-checker", () => {
  const urlset = (locs: Array<[string, string?]>) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
      .map(([l, m]) => `<url><loc>${l}</loc>${m ? `<lastmod>${m}</lastmod>` : ""}</url>`)
      .join("")}</urlset>`;

  it("parses urlsets, indexes, CDATA and entities", () => {
    const p = parseSitemapXml('<urlset><url><loc><![CDATA[https://x.com/a?b=1&c=2]]></loc></url><url><loc>https://x.com/b?x=1&amp;y=2</loc><lastmod>2026-09-01</lastmod></url></urlset>');
    expect(p.kind).toBe("urlset");
    expect(p.entries).toEqual([{ loc: "https://x.com/a?b=1&c=2", lastmod: null }, { loc: "https://x.com/b?x=1&y=2", lastmod: "2026-09-01" }]);
    expect(parseSitemapXml("<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>").kind).toBe("index");
    expect(isValidLastmod("2026-09-01T10:00:00+00:00")).toBe(true);
    expect(isValidLastmod("yesterday")).toBe(false);
    expect(sample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 3)).toEqual([1, 6, 11]);
  });

  it("discovers through robots.txt, follows the index, reads gzip, and samples URLs", async () => {
    const fetch = fakeFetch((url, opts) => {
      if (url === "https://x.com/robots.txt") return { body: "User-agent: *\nAllow: /\nSitemap: https://x.com/index.xml\n" };
      if (url === "https://x.com/index.xml")
        return { body: "<sitemapindex><sitemap><loc>https://x.com/a.xml</loc></sitemap><sitemap><loc>https://x.com/b.xml.gz</loc></sitemap></sitemapindex>" };
      if (url === "https://x.com/a.xml") return { body: urlset([["https://x.com/1", "2026-01-01"], ["https://x.com/2", "not a date"], ["/relative"]]) };
      if (url === "https://x.com/b.xml.gz") return { bodyBuffer: gzipSync(urlset([["https://x.com/3"], ["https://x.com/1"]])), body: "" };
      if (opts.method === "HEAD") return url.endsWith("/2") ? { status: 404 } : { status: 200 };
    });
    const blocks = await sitemapChecker.run({ url: "https://x.com/" }, ctxWith(fetch));
    const k = kvOf(blocks, "Sitemap");
    expect(item(k, "Sitemap files read")?.value).toBe("3");
    expect(item(k, "URLs listed")?.value).toBe("5");
    expect(item(k, "Invalid <lastmod>")?.value).toBe("1");
    expect(item(k, "Invalid entries")?.value).toBe("1");
    expect(item(k, "Duplicate URLs")?.value).toBe("1");
    expect(item(k, "Sampled URLs (3)")).toMatchObject({ status: "fail" });
  });

  it("falls back to /sitemap.xml and accepts a bare domain", async () => {
    const fetch = fakeFetch((url, opts) => {
      if (url === "https://x.com/robots.txt") return { status: 404 };
      if (url === "https://x.com/sitemap.xml") return { body: urlset([["https://x.com/1"]]) };
      if (opts.method === "HEAD") return { status: 200 };
    });
    const parsed = sitemapChecker.input.parse({ domain: "x.com" });
    const blocks = await sitemapChecker.run(parsed, ctxWith(fetch));
    expect(item(kvOf(blocks, "Sitemap"), "URLs listed")?.value).toBe("1");
    expect(fetch.mock.calls.some(([u]) => u === "https://x.com/sitemap_index.xml")).toBe(false);
  });

  it("caps the number of files", async () => {
    const children = Array.from({ length: 20 }, (_, i) => `<sitemap><loc>https://x.com/s${i}.xml</loc></sitemap>`).join("");
    const fetch = fakeFetch((url, opts) => {
      if (url === "https://x.com/sitemap.xml") return { body: `<sitemapindex>${children}</sitemapindex>` };
      if (/\/s\d+\.xml$/.test(url)) return { body: urlset([[`https://x.com/p${url}`]]) };
      if (opts.method === "HEAD") return { status: 200 };
    });
    const blocks = await sitemapChecker.run({ url: "https://x.com/sitemap.xml" }, ctxWith(fetch));
    expect(tableOf(blocks, "Files").rows).toHaveLength(MAX_FILES);
    expect(item(kvOf(blocks, "Sitemap"), "Sitemap files read")?.value).toMatch(/stopped at 5/);
  });

  it("says when there is no sitemap", async () => {
    const blocks = await sitemapChecker.run({ url: "https://x.com/" }, ctxWith(fakeFetch({ "https://x.com/robots.txt": { status: 404 } })));
    expect(item(kvOf(blocks, "Sitemap"), "Sitemap")).toMatchObject({ value: "none found", status: "fail" });
  });
});

// ── link-extractor ───────────────────────────────────────────────────────────

describe("link-extractor", () => {
  const html = page(
    '<base href="https://x.com/docs/">',
    [
      '<a href="intro">Intro</a>',
      '<a href="https://www.x.com/pricing" rel="nofollow">Pricing</a>',
      '<a href="https://other.org/" target="_blank" rel="sponsored">Partner</a>',
      '<a href="#top">Top</a>',
      '<a href="mailto:hi@x.com">Mail</a>',
      '<a href="javascript:void(0)">JS</a>',
      '<a href="https://y.org/"><img src="a.png" alt="Logo"></a>',
      "<!-- <a href=\"https://hidden.org\">hidden</a> -->",
      "<a name=anchor-only>no href</a>",
    ].join(""),
  );

  it("classifies, resolves against <base>, and reads rel/target/image anchors", () => {
    const links = extractLinks(html, "https://x.com/page");
    expect(links.map((l) => l.kind)).toEqual(["internal", "internal", "external", "anchor", "mailto", "javascript", "external"]);
    expect(links[0].url).toBe("https://x.com/docs/intro");
    expect(links[1].rel).toEqual(["nofollow"]);
    expect(links[2]).toMatchObject({ target: "_blank", rel: ["sponsored"] });
    expect(links[6].anchor).toBe("[image: Logo]");
  });

  it("runs end to end with counts", async () => {
    const blocks = await linkExtractor.run({ url: "https://x.com/page" }, ctxWith(fakeFetch({ "https://x.com/page": { body: html } })));
    const k = kvOf(blocks, "Summary");
    expect(item(k, "Internal")?.value).toBe("2");
    expect(item(k, "External")?.value).toBe("2 to 2 domains");
    expect(item(k, "rel=nofollow")?.value).toBe("1");
    expect(item(k, "javascript: links")?.status).toBe("warn");
    expect(tableOf(blocks, "Links").rows).toHaveLength(7);
  });

  it("refuses an error page", async () => {
    await expect(
      linkExtractor.run({ url: "https://x.com/" }, ctxWith(fakeFetch({ "https://x.com/": { status: 404, body: "nope" } }))),
    ).rejects.toMatchObject({ code: "upstream" });
  });
});
